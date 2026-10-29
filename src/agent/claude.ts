import { join } from "node:path";
import { looksLimited, oneLine, parseJsonLine, toolArg, type AgentLaunch, type AgentLaunchInput, type AgentResult, type AgentRunner, type ModelCheck } from "./runner.js";

/**
 * Claude Code headless (`claude -p`), with this Probe build as its only MCP server. It uses the
 * user's own Claude Code login, so there is no API key to manage. The default runner.
 */
export const claudeRunner: AgentRunner = {
  id: "claude",
  label: "Claude Code",
  command: "claude",
  versionArgs: ["--version"],
  installHint: "Install Claude Code (https://claude.com/claude-code) and log in",
  models: [
    ["sonnet", "Sonnet — balanced, included in most plans (recommended)"],
    ["haiku", "Haiku — fastest and cheapest, fine for simple cards"],
    ["opus", "Opus — strongest, uses your plan faster"],
    ["fable", "Fable — may bill usage credits on your plan"],
  ],

  launch({ task, model, mcp, scratchDir, id }: AgentLaunchInput): AgentLaunch {
    const mcpConfig = join(scratchDir, `agent-mcp-${id}.json`);
    const builtins = task.builtinTools ?? ["Read", "Grep", "Glob"];
    const scoped = (task.editOnly ?? []).flatMap((p) => [`Edit(${p})`, `Write(${p})`]);
    const allowed = [...task.probeTools.map((t) => `mcp__probe__${t}`), ...builtins, ...(task.allowEdits ? ["Edit", "Write"] : []), ...scoped];
    // A denied tool beats any allowed pattern, so scoped edits leave Edit and Write off this list.
    const denied = ["NotebookEdit", "Bash", "PowerShell", "WebFetch", "WebSearch", ...(task.allowEdits || scoped.length ? [] : ["Edit", "Write"])];
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
      ...(task.addDirs ?? []).flatMap((d) => ["--add-dir", d]),
    ];
    // Always explicit: without it the agent inherits the user's Claude Code default model.
    if (model) args.push("--model", model);
    return {
      command: "claude",
      args,
      input: task.prompt,
      env: nestedEnv(),
      files: [{ path: mcpConfig, content: JSON.stringify({ mcpServers: { probe: mcp } }) }],
    };
  },

  parser() {
    let result: AgentResult = { ok: false, summary: "Agent ended without a result.", costUsd: 0, turns: 0 };
    return {
      line(line) {
        const event = parseJsonLine(line);
        if (!event) return line.trim() ? [line] : [];
        if (event.type === "result") {
          result = {
            ok: event.subtype === "success" && !event.is_error,
            summary: String(event.result ?? event.subtype ?? ""),
            costUsd: Number(event.total_cost_usd ?? 0),
            turns: Number(event.num_turns ?? 0),
          };
        }
        return describe(event);
      },
      result: () => result,
    };
  },

  checkLaunch(model) {
    return {
      command: "claude",
      args: ["-p", "--model", model, "--output-format", "json", "--max-turns", "1", "--strict-mcp-config"],
      input: "Reply with the single word OK.",
      env: nestedEnv(),
      files: [],
    };
  },

  parseCheck(out, model): ModelCheck {
    try {
      const r = JSON.parse(out.slice(out.indexOf("{"))) as { result?: string; is_error?: boolean; total_cost_usd?: number; modelUsage?: Record<string, unknown> };
      const text = String(r.result ?? "").trim();
      const used = Object.keys(r.modelUsage ?? {})[0] ?? model;
      return { ok: !r.is_error && !looksLimited(text), model: used, message: text.slice(0, 300), costUsd: Number(r.total_cost_usd ?? 0) };
    } catch {
      return { ok: false, model, message: out.slice(0, 300) || "claude did not answer", costUsd: 0 };
    }
  },
};

/** A nested Claude Code refuses to start when it thinks it is inside another session. */
function nestedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  return env;
}

/** Turns stream-json events into short log lines. Events are loosely typed: only a few fields are read. */
function describe(event: { type: string } & Record<string, unknown>): string[] {
  if (event.type === "system" && event.subtype === "init") return [`agent started (${String(event.model ?? "default model")})`];
  if (event.type === "assistant") {
    const content = ((event.message as { content?: unknown[] })?.content ?? []) as { type: string; text?: string; name?: string; input?: Record<string, unknown> }[];
    return content.flatMap((c) => {
      if (c.type === "text" && c.text?.trim()) return [`💬 ${oneLine(c.text)}`];
      if (c.type === "tool_use") return [`→ ${String(c.name).replace(/^mcp__probe__/, "")} ${toolArg(c.input)}`];
      return [];
    });
  }
  if (event.type === "result") {
    return [`agent finished: ${event.subtype} · ${event.num_turns ?? "?"} turns · $${Number(event.total_cost_usd ?? 0).toFixed(3)}`];
  }
  return [];
}
