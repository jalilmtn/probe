import type { AgentRunnerId } from "../core/config.js";
import { claudeRunner } from "./claude.js";
import { codexRunner } from "./codex.js";
import type { AgentRunner } from "./runner.js";

const RUNNERS: Record<AgentRunnerId, AgentRunner> = {
  claude: claudeRunner,
  codex: codexRunner(),
};

/** The runner `agents.runner` names; Claude Code when it names none. */
export function agentRunner(id: AgentRunnerId | undefined): AgentRunner {
  return RUNNERS[id ?? "claude"] ?? claudeRunner;
}

export function allRunners(): AgentRunner[] {
  return Object.values(RUNNERS);
}
