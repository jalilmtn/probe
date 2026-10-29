import { runAgent } from "../agent/headless.js";
import { newRunId } from "../core/store.js";
import type { FeatureInfo, UnitWriteRun } from "../core/types.js";
import { dirtyFiles } from "./history.js";
import type { Project } from "./project.js";
import { launchRun } from "./runs.js";
import { findFeature, riskyGaps, scan } from "./scan.js";
import { startUnitRun } from "./unit.js";

function prompt(feature: FeatureInfo, targets: { name: string; file: string; kind: string }[]): string {
  return `You are writing missing unit tests for the feature "${feature.id}" of the project in the current directory.

## Classes to cover, most important first
${targets.map((t, i) => `${i + 1}. ${t.name} (${t.kind}) — ${t.file}`).join("\n")}

## How
1. Read the project's shared agent notes (AGENTS.md), any provider-specific notes, and docs for this feature; follow their testing rules.
2. Read neighbouring tests in the same module to copy their style, libraries, fakes and helpers. Reuse existing test helpers and fakes; do not invent a new framework.
3. For each class: read it, then write one test class next to the module's existing unit tests (the module's src/test source set), named <ClassName>Test.
   Each test pins one behaviour and must fail if that behaviour broke: real inputs and real assertions, no tests that only check a mock was called.
4. Only create or edit files under test source sets. Never change production code; if a class cannot be tested without changing it, skip it and say why.
5. Call probe_unit_run with feature "${feature.id}". If your tests fail to compile or fail, fix the tests (not the production code) and run again, at most three times.
6. Finish with a short summary: tests written per class, classes skipped and why.

Never commit, stage or push anything.`;
}

/**
 * An agent writes unit tests for the riskiest untested classes of a feature, then Probe runs
 * the feature's tests. The agent may edit files but never run commands; whatever it changed
 * outside test sources is listed for review, never reverted.
 */
export function startUnitWrite(project: Project, featureId: string, options: { limit?: number; model?: string } = {}): { run: UnitWriteRun; done: Promise<UnitWriteRun> } {
  const feature = findFeature(scan(project), featureId);
  if (!feature) throw new Error(`Unknown feature "${featureId}".`);
  const targets = riskyGaps(feature, options.limit ?? 5);
  if (targets.length === 0) throw new Error(`${feature.id} has no untested classes worth testing.`);

  const run: UnitWriteRun = {
    id: newRunId(),
    kind: "unitwrite",
    feature: feature.id,
    startedAt: new Date().toISOString(),
    status: "running",
    targets: targets.map((t) => t.name),
    files: [],
    outsideTests: [],
    costUsd: 0,
  };

  return launchRun(project, run, async (log) => {
    const before = dirtyFiles(project.root);
    const result = await runAgent(
      project,
      { prompt: prompt(feature, targets), probeTools: ["probe_feature", "probe_unit_run"], model: options.model, allowEdits: true },
      log,
    );
    run.costUsd = result.costUsd;

    // Files that became dirty, or changed state, during the run.
    const after = dirtyFiles(project.root);
    run.files = [...after.entries()].filter(([file, st]) => before.get(file) !== st).map(([file]) => file).sort();
    run.outsideTests = run.files.filter((f) => !project.adapter.isTestSource(f));
    log(`${run.files.length} files changed${run.outsideTests.length ? `, ${run.outsideTests.length} outside test sources (review them)` : ""}`);
    if (run.files.length === 0) {
      run.status = "failed";
      run.error = `No tests were written. Agent: ${result.summary.slice(0, 300)}`;
      return;
    }

    log("── running the feature's unit tests");
    const { run: unit, done } = startUnitRun(project, feature.id);
    run.unitRun = unit.id;
    const finished = await done;
    run.status = finished.status;
    if (finished.status !== "passed") run.error = `Unit tests after writing: ${finished.status}${finished.error ? ` (${finished.error})` : ""}.`;
    if (run.outsideTests.length && run.status === "passed") run.error = `Passed, but files outside test sources changed: ${run.outsideTests.join(", ")}`;
  });
}

export function summarizeUnitWrite(run: UnitWriteRun): string {
  const lines = [`Write tests ${run.id} · ${run.feature} · ${run.status.toUpperCase()} · ${run.files.length} files · $${run.costUsd.toFixed(2)}`];
  if (run.error) lines.push(run.error);
  lines.push(`  targets: ${run.targets.join(", ")}`);
  for (const f of run.files) lines.push(`  ${run.outsideTests.includes(f) ? "⚠" : "+"} ${f}`);
  if (run.unitRun) lines.push(`  unit run: ${run.unitRun}`);
  return lines.join("\n");
}
