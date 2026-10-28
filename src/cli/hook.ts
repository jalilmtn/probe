import { existsSync } from "node:fs";
import { join } from "node:path";
import { openProject, type Project } from "../engine/project.js";
import { formatReports, isProblem, kickCheck, loadWatch, markStale, runningCheck, studioUrl, sweepDirty, takeReports } from "../engine/watch.js";

/**
 * Claude Code hooks (hooks/hooks.json). Each reads the event as JSON on stdin and must be quick
 * and quiet: a hook that fails or stalls gets in the way of someone's session. So every error
 * is swallowed and nothing here builds or runs tests; that happens in a check, in the background.
 *
 * - edit:   after Edit/Write — mark the features the file belongs to stale.
 * - stop:   when Claude ends its turn — tell it about problems a finished check found (once),
 *           otherwise start a check of what is stale.
 * - prompt: when the user sends a message — pass on results that arrived since.
 */
export async function runHook(event: string): Promise<number> {
  try {
    const input = JSON.parse((await readStdin()) || "{}") as HookInput;
    const project = probeProject(input.cwd);
    if (!project || !project.config.watch.enabled) return 0;
    const session = input.session_id ?? "unknown";

    if (event === "edit") {
      const file = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
      if (file) markStale(project, [file], "claude", session);
      return 0;
    }

    if (event === "stop") {
      // Edits the Edit hook cannot see: shell commands, an IDE open alongside.
      sweepDirty(project, "claude", session);
      // A check that finished with problems is worth one more step of this turn. Only once:
      // stop_hook_active means this turn already continued because of a hook.
      if (!input.stop_hook_active) {
        const problems = takeReports(project, session, isProblem);
        if (problems.length) {
          process.stdout.write(JSON.stringify({ decision: "block", reason: formatReports(problems, studioUrl(project)) }));
          return 0;
        }
      }
      if (Object.keys(loadWatch(project).stale).length) await kickCheck(project, "claude");
      return 0;
    }

    if (event === "prompt") {
      const reports = takeReports(project, session);
      const lines: string[] = [];
      if (reports.length) lines.push(formatReports(reports, studioUrl(project)));
      const running = runningCheck(project);
      if (running) lines.push(`Probe is still checking features after recent edits (run ${running.runId}); results follow when it ends.`);
      if (lines.length) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: lines.join("\n\n") } }));
      return 0;
    }
  } catch (e) {
    // Never in the way of the session; PROBE_DEBUG=1 shows what went wrong.
    if (process.env.PROBE_DEBUG) process.stderr.write(`probe hook ${event}: ${(e as Error).stack}\n`);
  }
  return 0;
}

interface HookInput {
  session_id?: string;
  cwd?: string;
  stop_hook_active?: boolean;
  tool_input?: { file_path?: string; notebook_path?: string };
}

/** The project, but only one that uses Probe: a `probe/` folder in it says so. */
function probeProject(cwd: string | undefined): Project | null {
  try {
    const project = openProject(cwd);
    return existsSync(join(project.root, "probe")) ? project : null;
  } catch {
    return null;
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}
