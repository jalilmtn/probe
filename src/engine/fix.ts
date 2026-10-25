import { runAgent } from "../agent/headless.js";
import { startCardRun } from "../cards/run.js";
import { newRunId } from "../core/store.js";
import type { FixRun } from "../core/types.js";
import { dirtyFiles } from "./history.js";
import { findIssue, fixPrompt } from "./issues.js";
import type { Project } from "./project.js";
import { launchRun } from "./runs.js";
import { startUnitRun } from "./unit.js";

/**
 * An agent fixes one issue in the project's code, then Probe checks the fix: the feature's
 * unit tests, and for a problem seen on a device, the same card again from a fresh install.
 * The agent may edit files but never run commands or touch git; the changes stay uncommitted
 * for a person to review.
 */
export function startFix(project: Project, issueId: string, options: { model?: string; recheck?: boolean } = {}): { run: FixRun; done: Promise<FixRun> } {
  const found = findIssue(project, issueId);
  if (!found) throw new Error(`Unknown issue ${issueId}.`);
  const { issue, run: source } = found;

  const run: FixRun = {
    id: newRunId(),
    kind: "fix",
    feature: issue.feature,
    startedAt: new Date().toISOString(),
    status: "running",
    issue,
    files: [],
    costUsd: 0,
  };

  return launchRun(project, run, async (log) => {
    log(`fixing: ${issue.title}`);
    const before = dirtyFiles(project.root);
    const result = await runAgent(
      project,
      { prompt: fixPrompt(project, issue, source, true), probeTools: ["probe_feature", "probe_unit_run", "probe_cards_list"], model: options.model, allowEdits: true },
      log,
    );
    run.costUsd += result.costUsd;
    run.summary = result.summary.slice(0, 2000);

    const after = dirtyFiles(project.root);
    run.files = [...after.entries()].filter(([file, st]) => before.get(file) !== st).map(([file]) => file).sort();
    log(`${run.files.length} file(s) changed`);
    if (run.files.length === 0) {
      run.status = "blocked";
      run.error = `No change made. Agent: ${run.summary.slice(0, 300)}`;
      return;
    }

    log("── unit tests");
    const { run: unit, done } = startUnitRun(project, issue.feature);
    run.unitRun = unit.id;
    const unitDone = await done;
    if (unitDone.status !== "passed") {
      run.status = unitDone.status === "stopped" ? "stopped" : "failed";
      run.error = `Unit tests after the fix: ${unitDone.status}${unitDone.error ? ` (${unitDone.error})` : ""}.`;
      return;
    }

    const onDevice = issue.cardId && ["expectation", "card", "crash", "perf"].includes(issue.kind);
    if (onDevice && options.recheck !== false) {
      log(`── device: ${issue.feature}/${issue.cardId} again, from a fresh install`);
      const { run: card, done: cardDone } = startCardRun(project, issue.feature, issue.cardId!, { model: options.model, reinstall: true, parent: run.id });
      run.recheckRun = card.id;
      const finished = await cardDone;
      run.costUsd += finished.costUsd;
      run.status = finished.status === "passed" ? "passed" : finished.status === "stopped" ? "stopped" : "failed";
      if (run.status !== "passed") run.error = `The card still does not pass: ${finished.status}${finished.error ? ` (${finished.error})` : ""}.`;
      return;
    }
    run.status = "passed";
  });
}

export function summarizeFix(run: FixRun): string {
  const lines = [`Fix ${run.id} · ${run.feature} · ${run.status.toUpperCase()} · ${run.files.length} files · $${run.costUsd.toFixed(2)}`, `  issue: ${run.issue.title}`];
  if (run.error) lines.push(run.error);
  for (const f of run.files) lines.push(`  ~ ${f}`);
  if (run.unitRun) lines.push(`  unit run: ${run.unitRun}`);
  if (run.recheckRun) lines.push(`  device recheck: ${run.recheckRun}`);
  if (run.summary) lines.push("", run.summary);
  return lines.join("\n");
}
