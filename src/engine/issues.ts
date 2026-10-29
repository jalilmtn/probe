import { relative } from "node:path";
import { findCard } from "../cards/store.js";
import type { CardRun, ExploreRun, Run, RunIssue, UnitRun } from "../core/types.js";
import type { Project } from "./project.js";
import { findFeature, latestScan } from "./scan.js";

/**
 * Every problem a run found, one entry per thing someone could fix: a failing test, an unmet
 * expectation, a crash, a navigation issue, a performance warning. A verify or test-writing
 * run lists the problems of the runs it started, each under its own run id.
 */
export function issuesOf(project: Project, run: Run): RunIssue[] {
  const read = (id?: string) => (id ? project.store.read<Run>(`runs/${id}.json`) : null);
  if (run.kind === "verify") {
    return run.features.flatMap((f) => [read(f.unitRun), ...f.cards.map((c) => read(c.runId))].flatMap((r) => (r ? issuesOf(project, r) : [])));
  }
  if (run.kind === "unitwrite") {
    const unit = read(run.unitRun);
    return unit ? issuesOf(project, unit) : [];
  }

  const out: Omit<RunIssue, "id" | "runId" | "feature">[] = [];
  if (run.kind === "unit") out.push(...unitIssues(run));
  if (run.kind === "card" || run.kind === "explore" || run.kind === "login") {
    for (const c of run.crashes) out.push({ kind: "crash", title: `Crash: ${c.split("\n").find((l) => /Exception|Error/.test(l))?.trim().slice(0, 140) ?? "the app crashed"}`, detail: c });
  }
  if (run.kind === "card") out.push(...cardIssues(run));
  // "Not reached: …" is what the agent could not cover, not something to fix.
  if (run.kind === "explore") out.push(...(run as ExploreRun).issues.filter((i) => !/^(not reached|could not reach|not tested|untested)\b/i.test(i.trim())).map((i) => ({ kind: "navigation" as const, title: i.slice(0, 140), detail: i })));
  if (run.kind === "card" || run.kind === "explore") {
    for (const p of run.perf?.issues ?? []) out.push({ kind: "perf", title: `Slow: ${p}`, detail: p });
  }
  // An error is a broken build or install only when the log says so; a missing device is not the code's fault.
  if (run.status === "error" && run.error && out.length === 0 && /Installing|Build exited|compile|wrote no test reports/i.test(run.error)) {
    out.push({ kind: "build", title: run.error.slice(0, 140), detail: run.error });
  }
  return out.map((i, n) => ({ ...i, id: `${run.id}:${n}`, runId: run.id, feature: run.feature, cardId: run.kind === "card" ? run.cardId : undefined }));
}

function unitIssues(run: UnitRun): Omit<RunIssue, "id" | "runId" | "feature">[] {
  return run.results.flatMap((r) =>
    r.failures.map((t) => ({
      kind: "test" as const,
      title: `${t.className.split(".").pop()}.${t.name} fails`,
      detail: `${r.module} · ${t.className} · ${t.name}\n${t.message ?? "(no message)"}`,
    })),
  );
}

function cardIssues(run: CardRun): Omit<RunIssue, "id" | "runId" | "feature">[] {
  const v = run.verdict;
  if (!v || v.result !== "failed") return [];
  const unmet = v.expectations.filter((e) => e.met === false);
  if (unmet.length === 0) return [{ kind: "card", title: `Card ${run.cardId} failed`, detail: v.notes }];
  return unmet.map((e) => ({ kind: "expectation" as const, title: `Not true: ${e.text}`.slice(0, 160), detail: `${e.text}\nSeen: ${e.evidence}${v.notes ? `\nAgent notes: ${v.notes}` : ""}` }));
}

export function findIssue(project: Project, issueId: string): { issue: RunIssue; run: Run } | null {
  const runId = issueId.slice(0, issueId.lastIndexOf(":"));
  const run = project.store.read<Run>(`runs/${runId}.json`);
  const issue = run && issuesOf(project, run).find((i) => i.id === issueId);
  return run && issue ? { issue, run } : null;
}

/**
 * A self-contained prompt for fixing one issue: the problem, the evidence, where the code
 * lives and how to check the fix. `forProbe` words the checking step for Probe's own fix agent
 * (its tools); otherwise for a person pasting it into any coding agent.
 */
export function fixPrompt(project: Project, issue: RunIssue, run: Run, forProbe: boolean): string {
  const feature = findFeature(latestScan(project), issue.feature);
  const modules = feature?.modules.map((m) => `- ${m.id} — ${relative(project.root, m.dir).replace(/\\/g, "/") || "."}`).join("\n") ?? "- (unknown)";
  const parts = [`Fix one problem that Probe found in the "${issue.feature}" feature of the project in the current directory.`, `## The problem\n${issue.title}\n\n${issue.detail}`];

  const seen = [`- Run ${run.id} (${run.kind}), ${run.finishedAt ?? run.startedAt}`];
  if (run.git) seen.push(`- Code: ${run.git.branch ?? "detached HEAD"} @ ${run.git.commit}${run.git.dirty ? ` + ${run.git.dirty} uncommitted file(s)` : ""}`);
  if ("device" in run && typeof run.device === "string") seen.push(`- Device: ${run.device}`);
  parts.push(`## Where it was seen\n${seen.join("\n")}`);

  if (issue.cardId) {
    const card = findCard(project.root, issue.feature, issue.cardId);
    if (card) {
      parts.push(`## The feature card that was tested
${card.title}: ${card.summary}
Reach: ${card.reach.join(" → ")}
Steps:\n${card.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}
Must be true:\n${card.expect.map((e) => `- ${e.text}`).join("\n")}`);
    }
  }
  if (run.kind === "card" || run.kind === "explore") {
    const steps = run.timeline.slice(-12).map((t) => `- ${t.action}: ${t.detail.slice(0, 200)}`);
    if (steps.length) parts.push(`## What the device agent did last\n${steps.join("\n")}`);
  }
  parts.push(`## The feature's code (modules)\n${modules}`);

  const check = forProbe
    ? `4. Call probe_unit_run with feature "${issue.feature}". If it fails, fix and run again, at most three times. Probe re-runs the device check afterwards.`
    : `4. Run the feature's unit tests (\`/probe unit ${issue.feature}\` with Probe, or the module's unit test task) until they pass.${issue.cardId ? ` Then re-run the card on a device (\`/probe run ${issue.feature} ${issue.cardId}\`).` : ""}`;
  parts.push(`## How
1. Read the project's shared agent notes (AGENTS.md), any provider-specific notes, and docs for this feature; follow them.
2. Find the root cause in the code, then make the smallest change that fixes it. Do not touch unrelated code. Never weaken, skip or delete a test or an expectation to make it pass.
3. Where the cause can be unit-tested, add or extend a test that fails without the fix.
${check}
5. If the problem is not in the app's code (the card's expectation is wrong, the test environment, a flaky device), change nothing and say why.
6. Finish with: the root cause, the files you changed, and how you checked it.

Never commit, stage, push or switch branches.`);
  return parts.join("\n\n");
}
