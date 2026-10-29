import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { looksLimited, oneLine, parseJsonLine, toolArg, type AgentLaunch, type AgentLaunchInput, type AgentResult, type AgentRunner, type McpServerSpec, type ModelCheck } from "./runner.js";

/** The few settings carried over from the user's own Codex config, which the agent otherwise ignores. */
export interface CodexUserSettings {
  model?: string;
  /** `[windows] sandbox`, e.g. "elevated": without it workspace-write may not start on Windows. */
  windowsSandbox?: string;
}

/**
 * Codex CLI headless (`codex exec --json`), with this Probe build attached as an MCP server
 * through `-c mcp_servers.probe.*` overrides. It uses the user's own Codex login.
 *
 * Isolation: `--ignore-user-config` drops the user's other MCP servers and plugins, the way
 * Claude Code's --strict-mcp-config does (disabling them one by one breaks on plugin servers,
 * which have no config entry to switch off). Auth still comes from CODEX_HOME, and the user's
 * model and Windows sandbox mode are carried over by hand.
 *
 * Permissions differ from Claude Code: Codex has no separate Read/Grep tools, it reads files
 * through sandboxed shell commands. So a read-only task runs in the `read-only` sandbox, an
 * editing task in `workspace-write` (writes only inside the folder it works in), and a task
 * with no built-in tools (device runs) gets no shell at all. Codex's sandbox can read the
 * whole disk, so `addDirs` needs no flag (its --add-dir would make a folder writable).
 */
export function codexRunner(readSettings: () => CodexUserSettings = readCodexUserSettings): AgentRunner {
  const base = (settings: CodexUserSettings, model: string, sandbox: "read-only" | "workspace-write") => [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--ephemeral",
    "--ignore-user-config",
    "--sandbox",
    sandbox,
    ...(model || settings.model ? ["--model", model || settings.model!] : []),
    ...(settings.windowsSandbox ? ["-c", `windows.sandbox=${tomlString(settings.windowsSandbox)}`] : []),
    // Tools an agent run has no use for.
    ...UNUSED_FEATURES.flatMap((f) => ["--disable", f]),
  ];

  return {
    id: "codex",
    label: "Codex CLI",
    command: "codex",
    versionArgs: ["--version"],
    installHint: "Install Codex CLI (npm install -g @openai/codex) and run codex login",
    models: [["", "Codex default (your ~/.codex/config.toml)"]],

    launch({ task, model, mcp }: AgentLaunchInput): AgentLaunch {
      const edits = Boolean(task.allowEdits || task.editOnly?.length);
      const noShell = !edits && task.builtinTools !== undefined && task.builtinTools.length === 0;
      const args = [
        ...base(readSettings(), model, edits ? "workspace-write" : "read-only"),
        ...(noShell ? ["--disable", "shell_tool", "--disable", "unified_exec"] : []),
        ...mcpOverrides(mcp, task.probeTools),
        // The prompt comes on stdin.
        "-",
      ];
      return { command: "codex", args, input: task.prompt, env: { ...process.env }, files: [] };
    },

    parser: codexParser,

    checkLaunch(model) {
      return {
        command: "codex",
        args: [...base(readSettings(), model, "read-only"), "--disable", "shell_tool", "--disable", "unified_exec", "-"],
        input: "Reply with the single word OK.",
        env: { ...process.env },
        files: [],
      };
    },

    parseCheck(out, model): ModelCheck {
      const parser = codexParser();
      for (const line of out.split(/\r?\n/)) parser.line(line);
      const r = parser.result();
      const message = (r.summary || out).trim().slice(0, 300) || "codex did not answer";
      return { ok: r.ok && !looksLimited(r.summary), model: model || readSettings().model || "Codex default", message, costUsd: 0 };
    },
  };
}

/** Feature names from `codex features list`; none of them is useful to a Probe agent. */
const UNUSED_FEATURES = ["apps", "browser_use", "computer_use", "in_app_browser", "image_generation"];

/** Attaches the Probe MCP server with only `tools` enabled, approved up front (exec never asks). */
export function mcpOverrides(mcp: McpServerSpec, tools: string[]): string[] {
  const set = (key: string, value: string) => ["-c", `mcp_servers.probe.${key}=${value}`];
  return [
    ...set("command", tomlString(mcp.command)),
    ...set("args", `[${mcp.args.map(tomlString).join(", ")}]`),
    ...set("env", `{ ${Object.entries(mcp.env).map(([k, v]) => `${tomlString(k)} = ${tomlString(v)}`).join(", ")} }`),
    ...set("enabled_tools", `[${tools.map(tomlString).join(", ")}]`),
    // Without it every Probe tool call fails with "requires approval, but approval policy is never".
    ...set("default_tools_approval_mode", tomlString("approve")),
    // Running unit tests or a device step through Probe takes minutes, not Codex's default seconds.
    ...set("tool_timeout_sec", "3600"),
  ];
}

/**
 * A TOML string. Literal ('...') when it can be: no escapes, so Windows paths keep their
 * backslashes and the argument carries no double quotes for cmd.exe to mangle.
 */
export function tomlString(value: string): string {
  return /['\r\n]/.test(value) ? JSON.stringify(value) : `'${value}'`;
}

/** `codex exec --json` events: thread.started, item.started/completed, turn.completed/failed, error. */
function codexParser() {
  let result: AgentResult = { ok: false, summary: "", costUsd: 0, turns: 0 };
  let lastMessage = "";
  let steps = 0;
  let failure = "";
  return {
    line(line: string): string[] {
      const event = parseJsonLine(line);
      if (!event) return line.trim() ? [line] : [];
      const item = (event.item ?? {}) as { type?: string; text?: string; tool?: string; server?: string; arguments?: Record<string, unknown>; command?: string; changes?: { path?: string }[]; message?: string; status?: string; error?: { message?: string } | null };
      switch (event.type) {
        case "thread.started":
          return ["agent started (codex)"];
        case "item.started":
          if (item.type === "mcp_tool_call") return [`→ ${item.tool} ${toolArg(item.arguments)}`];
          if (item.type === "command_execution") return [`$ ${oneLine(String(item.command ?? ""), 160)}`];
          return [];
        case "item.completed":
          if (item.type === "agent_message" && item.text?.trim()) {
            lastMessage = item.text.trim();
            steps++;
            return [`💬 ${oneLine(item.text)}`];
          }
          if (item.type === "mcp_tool_call" || item.type === "command_execution" || item.type === "file_change") steps++;
          if (item.type === "mcp_tool_call" && item.error?.message) return [`⚠ ${item.tool}: ${oneLine(item.error.message)}`];
          if (item.type === "file_change") return (item.changes ?? []).map((c) => `✎ ${c.path ?? "file"}`);
          if (item.type === "error" && item.message) return [`⚠ ${oneLine(item.message)}`];
          return [];
        case "turn.completed": {
          result = { ok: true, summary: lastMessage, costUsd: 0, turns: steps };
          const usage = (event.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
          return [`agent finished: success · ${steps} steps · ${usage.input_tokens ?? "?"} in / ${usage.output_tokens ?? "?"} out tokens`];
        }
        case "turn.failed":
          failure = String(((event.error ?? {}) as { message?: string }).message ?? "turn failed");
          result = { ok: false, summary: failure, costUsd: 0, turns: steps };
          return [`agent finished: failed · ${oneLine(failure)}`];
        case "error":
          failure = String(event.message ?? "");
          return failure ? [`⚠ ${oneLine(failure)}`] : [];
        default:
          return [];
      }
    },
    result(): AgentResult {
      if (result.ok || result.summary) return result;
      return { ok: false, summary: failure || lastMessage || "Agent ended without a result.", costUsd: 0, turns: steps };
    },
  };
}

/**
 * Reads `model` and `[windows] sandbox` from $CODEX_HOME/config.toml (default ~/.codex). Two
 * keys do not justify a TOML parser: a line match is enough, and a miss only means defaults.
 */
export function readCodexUserSettings(home = process.env.CODEX_HOME || join(homedir(), ".codex")): CodexUserSettings {
  const file = join(home, "config.toml");
  if (!existsSync(file)) return {};
  return parseCodexUserSettings(readFileSync(file, "utf8"));
}

export function parseCodexUserSettings(text: string): CodexUserSettings {
  const settings: CodexUserSettings = {};
  let table = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      table = header[1]!.trim();
      continue;
    }
    const kv = /^([\w-]+)\s*=\s*["']([^"']*)["']/.exec(line);
    if (!kv) continue;
    if (table === "" && kv[1] === "model") settings.model = kv[2];
    if (table === "windows" && kv[1] === "sandbox") settings.windowsSandbox = kv[2];
  }
  return settings;
}
