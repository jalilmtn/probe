import { stringify } from "yaml";
import { accountsForPrompt, learnShownAs } from "../accounts/accounts.js";
import { newRunId } from "../core/store.js";
import type { BuildRef, Card, CardRun, RunTarget } from "../core/types.js";
import { appOn, crashError, howTo, runOnDevice } from "../devices/harness.js";
import type { Project } from "../engine/project.js";
import { cardFingerprint, recordCardResult } from "../engine/ledger.js";
import { launchRun } from "../engine/runs.js";
import { latestScan } from "../engine/scan.js";
import { listCards, recordDeviceRun } from "./store.js";

function prompt(project: Project, card: Card, device: string, app: string, target: RunTarget): string {
  return `You are a QA tester. Test this feature card on ${appOn(target, device, app)}. The app has just been ${target === "web" ? "opened" : "launched"}.

## Card
\`\`\`yaml
${stringify({ title: card.title, summary: card.summary, reach: card.reach, preconditions: card.preconditions, steps: card.steps, expect: card.expect, accounts: card.accounts })}\`\`\`

## Test accounts
${accountsForPrompt(project)}

${howTo(target)}

Follow the card's reach, preconditions and steps, then check every expectation ${target === "web" ? "in the browser" : "on the device"}.
If the app is logged in with an account that matches no test account (by username, email or shown name, checked as the safety rules say), the result is blocked with blockedBy "wrong-account". If you cannot log in, the result is blocked with blockedBy "sign-in" (stop at the first refused sign-in), or "needs-code" when it asks for a code you do not have. Make every precondition true before the steps. When one is not met and the signed-in test account can make it so (post a story, create a post, add an item), do it first, with plain test content (a photo already in the gallery, the text "Probe test"): that is part of this task. Only when a precondition cannot be made true that way (it needs another person, a payment, or data you cannot create), the result is blocked with blockedBy "missing-data" and the notes say exactly what is missing.

## Finish
Call probe_card_verdict exactly once (with signedInAs when you saw which test account the app uses): result passed (every expectation met), failed (an expectation was not met: say what you saw), or blocked (could not get far enough). For each expectation give met true/false/null and the evidence you saw. Then stop.`;
}

export interface CardRunOptions {
  device?: string;
  model?: string;
  /** Android or web; unset means the project's first target. */
  target?: RunTarget;
  /** A finished build to test instead of the working tree (Android). */
  build?: BuildRef;
  /** Reinstall from the current code first (verify does this for its first card). */
  reinstall?: boolean;
  /** The verify run this card run belongs to. */
  parent?: string;
}

/**
 * Runs one card on a device with a headless agent. Evidence (screenshots per step, a
 * timeline, a screen recording, performance, the verdict) lands in the run's folder. A crash
 * of the app fails the run whatever the agent concluded.
 */
export function startCardRun(project: Project, feature: string, cardId: string, options: CardRunOptions = {}): { run: CardRun; done: Promise<CardRun> } {
  const card = listCards(project.root, feature).find((c) => c.id === cardId);
  if (!card) throw new Error(`No card "${cardId}" in ${feature}.`);

  const run: CardRun = {
    id: newRunId(),
    kind: "card",
    feature,
    cardId,
    parent: options.parent,
    device: "",
    startedAt: new Date().toISOString(),
    status: "running",
    crashes: [],
    timeline: [],
    costUsd: 0,
  };

  return launchRun(project, run, async (log) => {
    const fingerprint = cardFingerprint(project, latestScan(project), card);
    const session = await runOnDevice(
      project,
      run,
      // Two files can carry the same version, so a file is installed again unless a verify already did.
      { device: options.device, model: options.model, target: options.target, build: options.build, install: options.reinstall || (options.build?.source === "file" && !options.parent) ? "always" : "missing", prompt: (d, app, target) => prompt(project, card, d, app, target), reportTools: ["probe_card_verdict"] },
      log,
    );
    run.verdict = session.verdict() ?? undefined;
    const seen = run.verdict?.signedInAs;
    if (seen) learnShownAs(project.root, seen.role, seen.seenAs, run.timeline, log);

    const crashed = crashError(run);
    if (crashed) {
      run.status = "failed";
      run.error = crashed;
    } else if (!run.verdict) {
      run.status = "error";
      run.error = "The agent finished without a verdict.";
    } else {
      run.status = run.verdict.result;
      if (run.status === "passed") recordDeviceRun(project.root, feature, cardId, run.id);
    }
    log(`verdict: ${run.status}${run.verdict?.notes ? ` · ${run.verdict.notes}` : ""}`);
    // The ledger says what holds for the code in the working tree. A finished build or a deployed
    // site is other code, so its result stays with the run (and the ticket), not in the ledger.
    if (!run.build && run.target !== "web") recordCardResult(project, run, fingerprint);
  });
}

export function summarizeCardRun(run: CardRun): string {
  const lines = [`Card run ${run.id} · ${run.feature}/${run.cardId} · ${run.status.toUpperCase()} · ${run.device} · ${run.timeline.length} steps · $${run.costUsd.toFixed(2)}`];
  if (run.error) lines.push(run.error);
  for (const e of run.verdict?.expectations ?? []) lines.push(`  ${e.met === true ? "✓" : e.met === false ? "✗" : "?"} ${e.text} — ${e.evidence}`);
  if (run.verdict?.notes) lines.push(`  notes: ${run.verdict.notes}`);
  if (run.perf) lines.push(`  perf: ${formatPerf(run.perf)}`);
  for (const issue of run.perf?.issues ?? []) lines.push(`  ⚠ ${issue}`);
  if (run.build) lines.push(`  build: ${run.build.label}`);
  for (const e of (run.webErrors ?? []).slice(0, 10)) lines.push(`  page: ${e}`);
  for (const c of run.crashes) lines.push(`  crash:\n${c}`);
  return lines.join("\n");
}

export function formatPerf(p: NonNullable<CardRun["perf"]>): string {
  return [p.startupMs !== undefined ? `start ${p.startupMs} ms` : "", `${p.frames} frames`, `${p.jankyPct}% janky`, `p50 ${p.p50Ms} / p90 ${p.p90Ms} / p99 ${p.p99Ms} ms`, p.memoryMb ? `${p.memoryMb} MB` : ""]
    .filter(Boolean)
    .join(" · ");
}
