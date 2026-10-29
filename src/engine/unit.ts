import { newRunId } from "../core/store.js";
import type { UnitRun } from "../core/types.js";
import type { Project } from "./project.js";
import { recordUnitResult, unitFingerprint } from "./ledger.js";
import { launchRun } from "./runs.js";
import { findFeature, latestScan } from "./scan.js";

/**
 * Starts the unit tests of one feature. Returns at once with the run; follow it through
 * `liveRun(id).events` or await `done`.
 */
export function startUnitRun(project: Project, featureId: string): { run: UnitRun; done: Promise<UnitRun> } {
  const feature = findFeature(latestScan(project), featureId);
  if (!feature) throw new Error(`Unknown feature "${featureId}". Run a scan or check the name.`);

  const modules = feature.modules.filter((m) => m.unitTestTask);
  const run: UnitRun = {
    id: newRunId(),
    kind: "unit",
    feature: feature.id,
    startedAt: new Date().toISOString(),
    status: "running",
    command: "",
    results: [],
  };

  return launchRun(project, run, async (log) => {
    if (modules.length === 0) {
      run.error = feature.stats.testFiles > 0 ? "This feature has tests but no command to run them: set unit.command in probe/probe.yaml." : "This feature has no unit tests.";
      return;
    }
    const fingerprint = unitFingerprint(project, latestScan(project), feature.id);
    const since = Date.now();
    const inv = await project.adapter.runUnitTests(project.root, modules, log, project.config);
    run.command = inv.command;
    run.results = project.adapter.collectUnitResults(project.root, modules, since, inv);
    const failed = run.results.some((r) => r.failed > 0);
    run.status = failed ? "failed" : inv.exitCode === 0 ? "passed" : "error";
    if (run.status === "error") run.error = `${project.adapter.supportsDevices ? "Build" : "The test command"} exited with code ${inv.exitCode} (see log: compile error or missing task).`;
    if (run.status === "passed" && run.results.length === 0) {
      run.status = "error";
      run.error = "The build succeeded but wrote no test reports.";
    }
    recordUnitResult(project, run, fingerprint);
  });
}

export function summarizeRun(run: UnitRun): string {
  const total = run.results.reduce((n, r) => n + r.tests, 0);
  const failed = run.results.reduce((n, r) => n + r.failed, 0);
  const lines = [`Unit run ${run.id} · ${run.feature} · ${run.status.toUpperCase()} · ${total} tests, ${failed} failed`];
  if (run.error) lines.push(run.error);
  for (const r of run.results) {
    lines.push(`  ${r.failed > 0 ? "✗" : "✓"} ${r.module}: ${r.tests} tests, ${r.failed} failed, ${r.skipped} skipped${r.cached ? " (cached: code unchanged)" : ""}`);
    for (const f of r.failures.slice(0, 10)) lines.push(`      - ${f.className}.${f.name}: ${f.message ?? ""}`.slice(0, 400));
  }
  return lines.join("\n");
}
