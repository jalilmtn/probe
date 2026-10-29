import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { capture } from "../core/proc.js";
import { openProject, type Project } from "../engine/project.js";
import { formatReports, isProblem, kickCheck, loadWatch, markStale, runningCheck, studioUrl, sweepDirty, takeReports, type ChangeSource } from "../engine/watch.js";

/**
 * How edits reach the watch loop. Each must be quick and quiet: a hook that fails or stalls gets
 * in the way of someone's session or commit. So every error is swallowed and nothing here builds
 * or runs tests; that happens in a check, in the background.
 *
 * Two callers:
 * - Claude Code hooks (hooks/hooks.json) send the event as JSON on stdin and read JSON back.
 * - Any other agent, a script or a person runs `probe hook <event> [files…]` and reads plain text.
 *
 * - edit:   after an edit — mark the features the files belong to stale.
 * - stop:   when the agent ends its turn — report problems a finished check found (once),
 *           otherwise start a check of what is stale.
 * - prompt: when the user sends a message — pass on results that arrived since.
 * - commit: from a git pre-commit hook (`probe hooks install`) — mark the staged files stale and
 *           start a check. Never blocks the commit.
 */
export async function runHook(event: string, options: HookOptions = {}): Promise<number> {
  try {
    const stdin = options.files?.length ? "" : await readStdin();
    const input = parseClaudeInput(stdin);
    const claude = input !== null;
    const hook = input ?? {};
    const project = probeProject(hook.cwd ?? options.project);
    if (!project || !project.config.watch.enabled) return 0;
    const source: ChangeSource = claude ? "claude" : event === "commit" ? "commit" : "agent";
    const session = hook.session_id ?? options.session ?? "agent";
    const say = (text: string) => process.stdout.write(`${text}\n`);

    if (event === "edit") {
      const file = hook.tool_input?.file_path ?? hook.tool_input?.notebook_path;
      const files = claude ? (file ? [file] : []) : (options.files ?? []).map((f) => (isAbsolute(f) ? f : resolve(process.cwd(), f)));
      // No files named: whatever changed since the last sweep.
      const touched = files.length ? markStale(project, files, source, session) : claude ? [] : sweepDirty(project, source, session);
      if (!claude && touched.length) say(`Probe: ${touched.join(", ")} stale`);
      return 0;
    }

    if (event === "stop") {
      // Edits the edit hook cannot see: shell commands, an IDE open alongside.
      sweepDirty(project, source, session);
      // A check that finished with problems is worth one more step of this turn. Only once:
      // stop_hook_active means this turn already continued because of a hook.
      if (!hook.stop_hook_active) {
        const problems = takeReports(project, session, isProblem);
        if (problems.length) {
          const reason = formatReports(problems, studioUrl(project));
          if (claude) process.stdout.write(JSON.stringify({ decision: "block", reason }));
          else say(reason);
          return 0;
        }
      }
      if (Object.keys(loadWatch(project).stale).length) {
        const started = await kickCheck(project, source);
        if (!claude) say(`Probe: checking stale features (${started === "busy" ? "a check is already running" : `in ${started}`})`);
      }
      return 0;
    }

    if (event === "prompt") {
      const reports = takeReports(project, session);
      const lines: string[] = [];
      if (reports.length) lines.push(formatReports(reports, studioUrl(project)));
      const running = runningCheck(project);
      if (running) lines.push(`Probe is still checking features after recent edits (run ${running.runId}); results follow when it ends.`);
      if (!lines.length) return 0;
      if (claude) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: lines.join("\n\n") } }));
      else say(lines.join("\n\n"));
      return 0;
    }

    if (event === "commit") {
      const staged = capture("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], project.root);
      const files = (staged ?? "").split(/\r?\n/).filter(Boolean).map((f) => join(project.root, f));
      if (files.length && markStale(project, files, "commit", session).length) await kickCheck(project, "commit");
      return 0;
    }
  } catch (e) {
    // Never in the way of the session; PROBE_DEBUG=1 shows what went wrong.
    if (process.env.PROBE_DEBUG) process.stderr.write(`probe hook ${event}: ${(e as Error).stack}\n`);
  }
  return 0;
}

export interface HookOptions {
  /** Files an agent edited (`probe hook edit a.ts b.ts`). */
  files?: string[];
  /** Whose results these are; reports are handed to each session once. */
  session?: string;
  project?: string;
}

interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  stop_hook_active?: boolean;
  tool_input?: { file_path?: string; notebook_path?: string };
}

/** Claude Code's hook payload, or null for anyone else. Claude Code always names the event. */
export function parseClaudeInput(stdin: string): HookInput | null {
  if (!stdin.trim().startsWith("{")) return null;
  try {
    const input = JSON.parse(stdin) as HookInput;
    return typeof input.hook_event_name === "string" ? input : null;
  } catch {
    return null;
  }
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

// ── git pre-commit hook ──────────────────────────────────────────────────────

const BEGIN = "# >>> probe (probe hooks install)";
const END = "# <<< probe";

/** The block Probe keeps in .git/hooks/pre-commit. It never fails the commit. */
export function preCommitBlock(probeScript: string): string {
  return [
    BEGIN,
    "# Marks the features of staged files stale and starts a Probe check in the background.",
    "if command -v probe >/dev/null 2>&1; then",
    "  probe hook commit >/dev/null 2>&1 || true",
    "else",
    `  node "${probeScript.replace(/\\/g, "/")}" hook commit >/dev/null 2>&1 || true`,
    "fi",
    END,
  ].join("\n");
}

/** Adds Probe's block to an existing hook (or a new one), replacing an older copy of it. */
export function withPreCommitBlock(existing: string | null, block: string): string {
  const kept = withoutPreCommitBlock(existing ?? "").trimEnd();
  const base = kept || "#!/bin/sh";
  return `${base}\n\n${block}\n`;
}

export function withoutPreCommitBlock(text: string): string {
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (start < 0 || end < start) return text;
  const kept = [text.slice(0, start).trimEnd(), text.slice(end + END.length).trim()].filter(Boolean);
  return kept.length ? `${kept.join("\n\n")}\n` : "";
}

/** `probe hooks install|uninstall|status`: the git pre-commit hook, for agents without hooks of their own. */
export function gitHooks(project: Project, action: string): string {
  const dir = capture("git", ["rev-parse", "--git-path", "hooks"], project.root);
  if (!dir) throw new Error("Not a git repository: the pre-commit hook needs git.");
  const file = resolve(project.root, dir, "pre-commit");
  const existing = existsSync(file) ? readFileSync(file, "utf8") : null;
  const installed = existing?.includes(BEGIN) ?? false;
  if (action === "install") {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, withPreCommitBlock(existing, preCommitBlock(resolve(process.argv[1]!))), { mode: 0o755 });
    return `${installed ? "Updated" : "Installed"} Probe's block in ${file}. Each commit now marks the staged files' features stale and starts a check in the background.`;
  }
  if (action === "uninstall") {
    if (!installed) return `No Probe block in ${file}.`;
    writeFileSync(file, withoutPreCommitBlock(existing!));
    return `Removed Probe's block from ${file}.`;
  }
  return installed ? `Installed in ${file}.` : `Not installed (probe hooks install adds it to ${file}).`;
}
