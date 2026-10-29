import { existsSync } from "node:fs";
import { agentRunner } from "../agent/runners.js";
import { configPath, type AgentRunnerId } from "../core/config.js";
import { capture } from "../core/proc.js";
import type { DoctorCheck } from "../core/types.js";
import { resolveApp } from "./app.js";
import { gitState } from "./history.js";
import type { Project } from "./project.js";

export function doctor(project: Project | null, error?: string): DoctorCheck[] {
  const major = Number(process.versions.node.split(".")[0]);
  const checks: DoctorCheck[] = [
    {
      id: "node",
      label: "Node.js",
      status: major >= 20 ? "ok" : "fail",
      detail: process.versions.node,
      fix: major >= 20 ? undefined : "Install Node 20 or newer",
    },
  ];

  checks.push(agentCliCheck(project?.config.agents.runner));

  if (!project) {
    checks.push({ id: "project", label: "Project", status: "fail", detail: error ?? "no supported project found" });
    return checks;
  }

  checks.push({ id: "project", label: "Project", status: "ok", detail: `${project.name} (${project.adapter.id}) at ${project.root}` });
  const hasConfig = existsSync(configPath(project.root));
  checks.push({
    id: "config",
    label: "probe/probe.yaml",
    status: "ok",
    detail: hasConfig ? "found" : "none yet: defaults and what Probe detects (Studio → Settings writes it when something is changed)",
  });
  const app = resolveApp(project);
  if (!project.adapter.supportsDevices) checks.push({ id: "app", label: "App to test", status: "ok", detail: `none: agents do not run ${project.adapter.label} apps on a device` });
  else checks.push({
    id: "app",
    label: "App to test",
    status: app.package && app.installTask ? "ok" : app.installTask ? "warn" : "fail",
    detail: app.package || app.installTask
      ? `${app.package ?? "id known after the first install"} · ${app.installTask ?? "no install task"}${app.packageSource && app.packageSource !== "probe.yaml" ? ` (from the ${app.packageSource})` : ""}`
      : "no application module found",
    fix: app.installTask ? undefined : "Set it in Studio → Settings → Project",
  });
  const git = gitState(project.root);
  checks.push({
    id: "git",
    label: "Branch",
    status: git?.branch ? "ok" : "warn",
    detail: git ? `${git.branch ?? "detached HEAD"} @ ${git.commit}${git.dirty ? ` + ${git.dirty} uncommitted` : ""}` : "not a git repository",
  });
  checks.push(...project.adapter.doctor(project.root, project.config));
  checks.push({ id: "store", label: "Local results", status: "ok", detail: project.store.dir });
  return checks;
}

/** The CLI `agents.runner` names, which every Probe agent job runs on. */
export function agentCliCheck(runnerId: AgentRunnerId | undefined, version = (cmd: string, args: string[]) => capture(cmd, args)): DoctorCheck {
  const runner = agentRunner(runnerId);
  const found = version(runner.command, runner.versionArgs);
  return {
    id: "agent-cli",
    label: `Agent CLI (${runner.id})`,
    status: found ? "ok" : "warn",
    detail: found ? `${runner.label} ${found}` : `${runner.command} not found (only needed for agent features: cards, device runs, test writing)`,
    fix: found ? undefined : `${runner.installHint}, or set agents.runner in probe/probe.yaml or Studio → Settings`,
  };
}

export function formatDoctor(checks: DoctorCheck[]): string {
  const icon = { ok: "✅", warn: "⚠️ ", fail: "❌" };
  return checks
    .map((c) => `${icon[c.status]} ${c.label.padEnd(20)} ${c.detail}${c.fix ? `\n     → ${c.fix}` : ""}`)
    .join("\n");
}
