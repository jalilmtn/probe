import { existsSync } from "node:fs";
import { configPath } from "../core/config.js";
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

  const claude = capture("claude", ["--version"]);
  checks.push({
    id: "claude",
    label: "Claude Code CLI",
    status: claude ? "ok" : "warn",
    detail: claude ?? "not found (only needed for agent features)",
    fix: claude ? undefined : "Install Claude Code",
  });

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
  checks.push({
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
  checks.push(...project.adapter.doctor(project.root));
  checks.push({ id: "store", label: "Local results", status: "ok", detail: project.store.dir });
  return checks;
}

export function formatDoctor(checks: DoctorCheck[]): string {
  const icon = { ok: "✅", warn: "⚠️ ", fail: "❌" };
  return checks
    .map((c) => `${icon[c.status]} ${c.label.padEnd(20)} ${c.detail}${c.fix ? `\n     → ${c.fix}` : ""}`)
    .join("\n");
}
