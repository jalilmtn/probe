import { rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stream } from "../core/proc.js";
import type { Project } from "../engine/project.js";

export interface AgentTask {
  prompt: string;
  /** Probe MCP tool names (without prefix) the agent may call. */
  probeTools: string[];
  /** Read-only built-in tools are allowed by default; nothing that edits or runs commands. */
  builtinTools?: string[];
  model?: string;
  /** Extra environment for the agent's Probe MCP server, e.g. the device session. */
  mcpEnv?: Record<string, string>;
  /** Lets the agent create and edit files (writing unit tests). It still never runs commands. */
  allowEdits?: boolean;
}

export interface AgentResult {
  ok: boolean;
  summary: string;
  costUsd: number;
  turns: number;
}

/**
 * Runs Claude Code headless (`claude -p`) in the project, with this Probe build as its only
 * MCP server. It uses the user's own Claude Code login, so there is no API key to manage.
 */
export async function runAgent(project: Project, task: AgentTask, log: (line: string) => void): Promise<AgentResult> {
  // One config per agent: two agents running at once must not share a session.
  const mcpConfig = join(project.store.dir, `agent-mcp-${process.pid}-${Date.now()}.json`);
  writeFileSync(
    mcpConfig,
    JSON.stringify({
      mcpServers: {
        probe: { command: process.execPath, args: [resolve(process.argv[1]!), "mcp"], env: { PROBE_PROJECT: project.root, ...task.mcpEnv } },
      },
    }),
  );

  const builtins = task.builtinTools ?? ["Read", "Grep", "Glob"];
  const allowed = [...task.probeTools.map((t) => `mcp__probe__${t}`), ...builtins, ...(task.allowEdits ? ["Edit", "Write"] : [])];
  const denied = ["NotebookEdit", "Bash", "PowerShell", "WebFetch", "WebSearch", ...(task.allowEdits ? [] : ["Edit", "Write"])];
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--mcp-config",
    mcpConfig,
    "--strict-mcp-config",
    "--allowedTools",
    allowed.join(","),
    "--disallowedTools",
    denied.join(","),
  ];
  // Always explicit: without it the agent inherits the user's Claude Code default model.
  args.push("--model", task.model ?? project.config.agents.model);

  // A nested Claude Code refuses to start when it thinks it is inside another session.
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;

  let result: AgentResult = { ok: false, summary: "Agent ended without a result.", costUsd: 0, turns: 0 };
  let exitCode: number;
  try {
  exitCode = await stream(
    "claude",
    args,
    project.root,
    (line) => {
      const event = parseEvent(line);
      if (!event) {
        if (line.trim()) log(line);
        return;
      }
      for (const text of describe(event)) log(text);
      if (event.type === "result") {
        result = {
          ok: event.subtype === "success" && !event.is_error,
          summary: String(event.result ?? event.subtype ?? ""),
          costUsd: Number(event.total_cost_usd ?? 0),
          turns: Number(event.num_turns ?? 0),
        };
      }
    },
    { input: task.prompt, env },
  );
  } finally {
    // Also when the run is stopped mid-way.
    rmSync(mcpConfig, { force: true });
  }
  if (exitCode !== 0 && result.ok) result.ok = false;
  return result;
}

/**
 * One tiny prompt on `model` with the user's login, to see whether their plan can run it
 * before a long run fails on "out of usage credits".
 */
export async function checkModel(project: Project, model: string): Promise<{ ok: boolean; model: string; message: string; costUsd: number }> {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  let out = "";
  await stream("claude", ["-p", "--model", model, "--output-format", "json", "--max-turns", "1", "--strict-mcp-config"], project.root, (l) => (out += l), {
    input: "Reply with the single word OK.",
    env,
  });
  try {
    const r = JSON.parse(out.slice(out.indexOf("{"))) as { result?: string; is_error?: boolean; total_cost_usd?: number; modelUsage?: Record<string, unknown> };
    const text = String(r.result ?? "").trim();
    const used = Object.keys(r.modelUsage ?? {})[0] ?? model;
    // A plan limit comes back as a normal "result" whose text is the limit message.
    const limited = /usage credits|usage limit|out of .*credits|rate limit/i.test(text);
    return { ok: !r.is_error && !limited, model: used, message: text.slice(0, 300), costUsd: Number(r.total_cost_usd ?? 0) };
  } catch {
    return { ok: false, model, message: out.slice(0, 300) || "claude did not answer", costUsd: 0 };
  }
}

// stream-json events are loosely typed on purpose: only a few fields are read.
type StreamEvent = { type: string; subtype?: string; [key: string]: unknown };

function parseEvent(line: string): StreamEvent | null {
  if (!line.startsWith("{")) return null;
  try {
    return JSON.parse(line) as StreamEvent;
  } catch {
    return null;
  }
}

/** Turns agent events into short log lines for Studio and the terminal. */
function describe(event: StreamEvent): string[] {
  if (event.type === "system" && event.subtype === "init") return [`agent started (${String(event.model ?? "default model")})`];
  if (event.type === "assistant") {
    const content = ((event.message as { content?: unknown[] })?.content ?? []) as { type: string; text?: string; name?: string; input?: Record<string, unknown> }[];
    return content.flatMap((c) => {
      if (c.type === "text" && c.text?.trim()) return [`💬 ${c.text.trim().replace(/\s+/g, " ").slice(0, 300)}`];
      if (c.type === "tool_use") return [`→ ${String(c.name).replace(/^mcp__probe__/, "")} ${toolArg(c.input)}`];
      return [];
    });
  }
  if (event.type === "result") {
    return [`agent finished: ${event.subtype} · ${event.num_turns ?? "?"} turns · $${Number(event.total_cost_usd ?? 0).toFixed(3)}`];
  }
  return [];
}

function toolArg(input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  if (input.action) return [input.action, input.element ?? input.text ?? input.key ?? input.direction ?? ""].join(" ").trim();
  if (input.result) return String(input.result);
  const first = input.file_path ?? input.pattern ?? input.path ?? input.feature ?? input.role;
  if (first !== undefined) return String(first).slice(0, 120);
  if (Array.isArray(input.cards)) return `(${input.cards.length} cards)`;
  return "";
}
