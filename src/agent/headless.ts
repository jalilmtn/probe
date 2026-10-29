import { rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { stream } from "../core/proc.js";
import type { Project } from "../engine/project.js";
import type { AgentLaunch, AgentResult, AgentTask, McpServerSpec, ModelCheck } from "./runner.js";
import { agentRunner } from "./runners.js";

export type { AgentResult, AgentTask } from "./runner.js";

/**
 * Runs one Probe agent headless in the project, on the coding-agent CLI `agents.runner` names
 * (Claude Code by default), with this Probe build as its MCP server. It uses the user's own login
 * for that CLI, so there is no API key to manage. Stopping the run (`runSignal`) kills it.
 */
export async function runAgent(project: Project, task: AgentTask, log: (line: string) => void): Promise<AgentResult> {
  const runner = agentRunner(project.config.agents.runner);
  const launch = runner.launch({
    task,
    model: task.model ?? project.config.agents.model,
    mcp: probeMcpServer(project, task.mcpEnv),
    scratchDir: project.store.dir,
    // Two agents running at once must not share a config file.
    id: `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  });
  const parser = runner.parser();
  const exitCode = await withFiles(launch, () =>
    stream(launch.command, launch.args, task.cwd ?? project.root, (line) => parser.line(line).forEach(log), { input: launch.input, env: launch.env }),
  );
  const result = parser.result();
  if (exitCode !== 0 && result.ok) result.ok = false;
  return result;
}

/**
 * One tiny prompt on `model` with the user's login, to see whether their plan can run it
 * before a long run fails on "out of usage credits".
 */
export async function checkModel(project: Project, model: string): Promise<ModelCheck> {
  const runner = agentRunner(project.config.agents.runner);
  const launch = runner.checkLaunch(model);
  let out = "";
  try {
    await withFiles(launch, () => stream(launch.command, launch.args, project.root, (l) => (out += `${l}\n`), { input: launch.input, env: launch.env }));
  } catch (e) {
    return { ok: false, model, message: `${runner.label} did not start: ${(e as Error).message}`, costUsd: 0 };
  }
  return runner.parseCheck(out, model);
}

/** This Probe build as an MCP server for the project. */
export function probeMcpServer(project: Project, extraEnv: Record<string, string> = {}): McpServerSpec {
  return { command: process.execPath, args: [resolve(process.argv[1]!), "mcp"], env: { PROBE_PROJECT: project.root, ...extraEnv } };
}

async function withFiles<T>(launch: AgentLaunch, work: () => Promise<T>): Promise<T> {
  for (const f of launch.files) writeFileSync(f.path, f.content);
  try {
    return await work();
  } finally {
    // Also when the run is stopped mid-way.
    for (const f of launch.files) rmSync(f.path, { force: true });
  }
}
