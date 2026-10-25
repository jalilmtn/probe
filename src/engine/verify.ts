import { relative } from "node:path";
import { startCardRun } from "../cards/run.js";
import { listCards } from "../cards/store.js";
import { throwIfStopped } from "../core/proc.js";
import { newRunId } from "../core/store.js";
import type { Card, RunStatus, ScanResult, VerifyFeature, VerifyRun } from "../core/types.js";
import { changedFiles, commitsForTicket, defaultBase, filesOfCommit } from "./history.js";
import { resultsOverview } from "./ledger.js";
import type { Project } from "./project.js";
import { launchRun } from "./runs.js";
import { scan } from "./scan.js";
import { startUnitRun } from "./unit.js";

export interface VerifyOptions {
  base?: string;
  /** Check these features instead of the ones the diff touches. */
  features?: string[];
  /** Check the features a ticket's commits touched, and run its cards first. */
  ticket?: string;
  /** Unit tests only. */
  noDevice?: boolean;
  cards?: "approved" | "all";
  maxCards?: number;
  device?: string;
  model?: string;
  /**
   * Bring results up to date instead of checking a diff: every feature with a unit result or
   * card result that is outdated, maybe outdated or missing, and only those results.
   */
  outdated?: boolean;
  /** Also re-run cards whose result still holds for this code (normally skipped). */
  rerunFresh?: boolean;
}

/** Which feature owns each file: the module whose folder is the longest prefix of it. */
export function featuresOfFiles(project: Project, result: ScanResult, files: string[]): { byFeature: Map<string, string[]>; unowned: string[] } {
  const dirs = result.features
    .flatMap((f) => f.modules.map((m) => ({ feature: f.id, dir: `${relative(project.root, m.dir).replace(/\\/g, "/")}/` })))
    .sort((a, b) => b.dir.length - a.dir.length);
  const byFeature = new Map<string, string[]>();
  const unowned: string[] = [];
  for (const file of files) {
    const owner = dirs.find((d) => file.startsWith(d.dir));
    if (!owner) {
      unowned.push(file);
      continue;
    }
    byFeature.set(owner.feature, [...(byFeature.get(owner.feature) ?? []), file]);
  }
  return { byFeature, unowned };
}

/**
 * The cards worth running for a feature in a verify, best first: regressions guarding the
 * ticket or a past bug, then flows, then the overview.
 */
function pickCards(cards: Card[], which: "approved" | "all", ticket?: string): Card[] {
  const rank = (c: Card) => (ticket && c.tickets.includes(ticket) ? 0 : c.level === "regression" ? 1 : c.level === "capability" ? 2 : 3);
  return cards.filter((c) => c.status !== "rejected" && (which === "all" || c.status === "approved")).sort((a, b) => rank(a) - rank(b));
}

/**
 * Checks a change end to end: maps its files to features, runs each feature's unit tests,
 * then (unless told not to) installs the current build once and runs the features' cards on
 * a device. Every step is its own run, linked from this one.
 */
export function startVerify(project: Project, options: VerifyOptions = {}): { run: VerifyRun; done: Promise<VerifyRun> } {
  const base = options.base ?? defaultBase(project.root, project.config.verify.base);
  if (!base && !options.features?.length && !options.ticket && !options.outdated) throw new Error("No base branch found to compare with. Pass --base or set verify.base in probe/probe.yaml.");

  const run: VerifyRun = {
    id: newRunId(),
    kind: "verify",
    feature: "*",
    base: options.outdated ? "outdated results" : options.ticket ? `ticket ${options.ticket}` : options.features?.length ? "selected features" : base!,
    startedAt: new Date().toISOString(),
    status: "running",
    changed: [],
    unowned: [],
    features: [],
    device: !options.noDevice,
    costUsd: 0,
  };

  return launchRun(project, run, async (log) => {
    // A fresh scan: the change may have added modules or tests.
    const result = scan(project);
    const overview = resultsOverview(project, result);
    const which = options.cards ?? project.config.verify.cards;
    let targets: Map<string, string[]>;
    if (options.outdated) {
      const wanted = result.features.filter((f) => {
        const unitOld = f.stats.testFiles > 0 && overview.unit.get(f.id)?.state !== "fresh";
        const cardsOld = pickCards(listCards(project.root, f.id), which).some((c) => overview.cards.get(`${f.id}/${c.id}`)?.state !== "fresh");
        return (!options.features?.length || options.features.includes(f.id)) && (unitOld || (!options.noDevice && cardsOld));
      });
      targets = new Map(wanted.map((f) => [f.id, []]));
      log(`${targets.size} features have outdated or missing results`);
    } else if (options.features?.length) {
      targets = new Map(options.features.map((f) => [f, []]));
    } else {
      run.changed = options.ticket
        ? [...new Set(commitsForTicket(project.root, options.ticket).flatMap((c) => filesOfCommit(project.root, c.hash)))]
        : changedFiles(project.root, base!);
      const owned = featuresOfFiles(project, result, run.changed);
      targets = owned.byFeature;
      run.unowned = owned.unowned;
      log(`${run.changed.length} changed files${options.ticket ? ` in commits of ${options.ticket}` : ` since ${base}`} → ${targets.size} features${run.unowned.length ? `, ${run.unowned.length} files outside any module` : ""}`);
    }
    if (targets.size === 0) {
      if (options.outdated) log("every result is up to date");
      else run.error = "The change touches no feature's code.";
      return;
    }
    const known = new Set(result.features.map((f) => f.id));
    run.features = [...targets.entries()].filter(([id]) => known.has(id)).map(([feature, files]) => ({ feature, files, cards: [] }));

    for (const f of run.features) {
      throwIfStopped();
      if (options.outdated && overview.unit.get(f.feature)?.state === "fresh") {
        const e = overview.unit.get(f.feature)!.entry!;
        f.unitRun = e.run;
        f.unitStatus = e.result;
        log(`${f.feature}: unit ${e.result}, up to date (run ${e.run})`);
        continue;
      }
      log(`── unit: ${f.feature}`);
      const feature = result.features.find((x) => x.id === f.feature);
      if (!feature?.modules.some((m) => m.unitTestTask)) {
        f.unitStatus = "blocked";
        log(`${f.feature}: no unit tests`);
        continue;
      }
      const { run: unit, done } = startUnitRun(project, f.feature);
      f.unitRun = unit.id;
      const finished = await done;
      f.unitStatus = finished.status;
      log(`${f.feature}: unit ${finished.status}`);
    }

    if (!options.noDevice) {
      let budget = options.maxCards ?? project.config.verify.maxCards;
      let first = true;
      for (const f of run.features) {
        const cards = pickCards(listCards(project.root, f.feature), which, options.ticket);
        if (cards.length === 0) {
          f.cards.push({ cardId: "—", status: "skipped", note: which === "approved" ? "no approved cards" : "no cards" });
          continue;
        }
        for (const card of cards) {
          throwIfStopped();
          // A result on exactly this code and card would only repeat itself.
          const known = overview.cards.get(`${f.feature}/${card.id}`);
          if (known?.state === "fresh" && !options.rerunFresh) {
            const e = known.entry!;
            f.cards.push({ cardId: card.id, runId: e.run, status: e.result === "passed" ? "skipped" : e.result, note: `${e.result} on this same code (${e.by ?? "run"} ${e.at.slice(0, 10)}); not re-run` });
            log(`${f.feature}/${card.id}: ${e.result}, up to date — skipped`);
            continue;
          }
          if (budget <= 0) {
            f.cards.push({ cardId: card.id, status: "skipped", note: "over verify.maxCards" });
            continue;
          }
          budget--;
          log(`── device: ${f.feature}/${card.id}`);
          // The first card reinstalls from this code; the rest test the same build.
          const { run: child, done } = startCardRun(project, f.feature, card.id, { device: options.device, model: options.model, reinstall: first, parent: run.id });
          first = false;
          const finished = await done;
          run.costUsd += finished.costUsd;
          f.cards.push({ cardId: card.id, runId: child.id, status: finished.status, note: finished.error ?? finished.verdict?.notes?.slice(0, 200) });
          log(`${f.feature}/${card.id}: ${finished.status}`);
          // A build that does not install will not install for the next card either.
          if (finished.status === "error" && /Installing/.test(finished.error ?? "")) budget = 0;
        }
      }
    }

    run.status = overall(run.features);
  });
}

function overall(features: VerifyFeature[]): RunStatus {
  const all = features.flatMap((f) => [f.unitStatus, ...f.cards.map((c) => c.status)]).filter((s): s is RunStatus => !!s && s !== ("skipped" as string));
  if (all.includes("failed")) return "failed";
  if (all.includes("error")) return "error";
  if (all.includes("blocked")) return "blocked";
  return "passed";
}

export function summarizeVerify(run: VerifyRun): string {
  const lines = [`Verify ${run.id} · vs ${run.base} · ${run.status.toUpperCase()} · ${run.features.length} features · ${run.changed.length} changed files · $${run.costUsd.toFixed(2)}`];
  if (run.error) lines.push(run.error);
  for (const f of run.features) {
    lines.push(`  ${f.feature}: unit ${f.unitStatus ?? "—"}${f.unitRun ? ` (${f.unitRun})` : ""} · ${f.files.length} files`);
    for (const c of f.cards) lines.push(`    ${c.status.padEnd(7)} ${c.cardId}${c.runId ? ` (${c.runId})` : ""}${c.note ? ` — ${c.note}` : ""}`);
  }
  if (run.unowned.length) lines.push(`  outside any module: ${run.unowned.slice(0, 15).join(", ")}${run.unowned.length > 15 ? "…" : ""}`);
  return lines.join("\n");
}
