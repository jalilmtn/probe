import type { AgentRunnerId } from "../core/config.js";

/**
 * What a Probe agent may do, independent of the CLI it runs on. Each runner maps it onto its own
 * permission model as closely as that CLI allows (see each runner for where they differ).
 */
export interface AgentTask {
  prompt: string;
  /** Probe MCP tool names (without prefix) the agent may call. */
  probeTools: string[];
  /** Read-only built-in tools are allowed by default; nothing that edits or runs commands. An empty list: Probe tools only. */
  builtinTools?: string[];
  model?: string;
  /** Extra environment for the agent's Probe MCP server, e.g. the device session. */
  mcpEnv?: Record<string, string>;
  /** Lets the agent create and edit files (writing unit tests). It still never runs commands. */
  allowEdits?: boolean;
  /** Folder the agent works in; the project by default. */
  cwd?: string;
  /** More folders the agent may read, e.g. the project when it works in a scratch folder. */
  addDirs?: string[];
  /**
   * Lets the agent edit only files matching these permission patterns (`./**` = its own folder).
   * Everything else stays read-only, unlike allowEdits.
   */
  editOnly?: string[];
}

export interface AgentResult {
  ok: boolean;
  summary: string;
  /** 0 when the CLI does not report a price (Codex reports tokens only). */
  costUsd: number;
  turns: number;
}

/** The Probe MCP server an agent gets, as a command line. */
export interface McpServerSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Everything a runner needs to build one agent's command line. */
export interface AgentLaunchInput {
  task: AgentTask;
  /** "" = the runner's own default. */
  model: string;
  mcp: McpServerSpec;
  /** A folder the runner may write its own config files to (removed after the run). */
  scratchDir: string;
  /** Unique per agent, for file names: two agents running at once must not share a config. */
  id: string;
}

/** One process to start. Built by a pure function, so argument building is testable. */
export interface AgentLaunch {
  command: string;
  args: string[];
  /** Written to stdin, which is then closed. */
  input: string;
  env: NodeJS.ProcessEnv;
  /** Written before the run and removed after it, also when it is stopped. */
  files: { path: string; content: string }[];
}

/** Reads a runner's output line by line; one per run. */
export interface AgentOutputParser {
  /** Short log lines for Studio and the terminal. */
  line(line: string): string[];
  result(): AgentResult;
}

export interface ModelCheck {
  ok: boolean;
  model: string;
  message: string;
  costUsd: number;
}

/**
 * A coding-agent CLI that can run headless with an MCP server attached. Probe starts every
 * agent job (drafting cards, device runs, explore, login, writing tests, fix, init, drafts)
 * through one of these, chosen with `agents.runner`.
 */
export interface AgentRunner {
  id: AgentRunnerId;
  label: string;
  /** The executable, checked by `probe doctor`. */
  command: string;
  versionArgs: string[];
  installHint: string;
  /** Model choices Studio offers ("" = the CLI's default). */
  models: [string, string][];
  launch(input: AgentLaunchInput): AgentLaunch;
  parser(): AgentOutputParser;
  /** One tiny prompt on `model`, to see whether the user's plan can run it. */
  checkLaunch(model: string): AgentLaunch;
  parseCheck(output: string, model: string): ModelCheck;
}

/** Short text for a tool call's arguments in the log. */
export function toolArg(input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  if (input.action) return [input.action, input.element ?? input.text ?? input.key ?? input.direction ?? ""].join(" ").trim();
  if (input.result) return String(input.result);
  const first = input.file_path ?? input.pattern ?? input.path ?? input.feature ?? input.role;
  if (first !== undefined) return String(first).slice(0, 120);
  if (Array.isArray(input.cards)) return `(${input.cards.length} cards)`;
  return "";
}

export function oneLine(text: string, max = 300): string {
  return text.trim().replace(/\s+/g, " ").slice(0, max);
}

/** A plan limit comes back as an ordinary answer whose text is the limit message. */
export function looksLimited(text: string): boolean {
  return /usage credits|usage limit|out of .*credits|rate limit|quota/i.test(text);
}

export function parseJsonLine(line: string): ({ type: string } & Record<string, unknown>) | null {
  if (!line.startsWith("{")) return null;
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === "object" && typeof (value as { type?: unknown }).type === "string" ? (value as { type: string } & Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
