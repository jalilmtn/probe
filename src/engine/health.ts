import { navMap } from "../cards/explore.js";
import { countCards, listCards, type CardCounts } from "../cards/store.js";
import type { CardRun, Run, RunStatus, ScanResult, UnitRun } from "../core/types.js";
import { resultsOverview, type FreshInfo, type Freshness } from "./ledger.js";
import type { Project } from "./project.js";

export type Health = "ok" | "warn" | "fail" | "unknown";

export interface CardLastRun {
  runId: string;
  status: RunStatus;
  at: string;
  perfIssues: number;
  /** Whether that result still holds for the code checked out here. */
  fresh?: Freshness;
  freshReasons?: string[];
  /** Recorded on another machine (from probe/results): no evidence here. */
  by?: string;
  remote?: boolean;
}

export interface FeatureHealth {
  health: Health;
  /** Why the health is what it is, worst first. */
  reasons: string[];
  unit: { runId: string; status: RunStatus; tests: number; failed: number; at: string; fresh: Freshness; freshReasons: string[]; by?: string; remote?: boolean } | null;
  cards: CardCounts | null;
  /** `stale`: results whose code changed since; `maybe`: only something they depend on changed. */
  device: { passed: number; failed: number; blocked: number; error: number; notRun: number; stale: number; maybe: number; lastAt: string | null };
  nav: { screens: number; issues: number; at: string } | null;
  perfIssues: number;
}

/** Newest finished run per card, keyed "feature/cardId". */
export function lastCardRuns(runs: Run[]): Map<string, CardLastRun> {
  const out = new Map<string, CardLastRun>();
  for (const r of runs) {
    if (r.kind !== "card" || r.status === "running" || r.status === "stopped") continue;
    const key = `${r.feature}/${(r as CardRun).cardId}`;
    if (!out.has(key)) out.set(key, { runId: r.id, status: r.status, at: r.finishedAt ?? r.startedAt, perfIssues: r.perf?.issues.length ?? 0 });
  }
  return out;
}

/**
 * Each card's latest result, from this machine's runs or the shared probe/results ledger,
 * whichever is newer, with whether it still holds for the code here.
 */
export function cardResults(project: Project, scan: ScanResult, overview = resultsOverview(project, scan)): Map<string, CardLastRun> {
  const local = lastCardRuns(project.store.listRuns<Run>());
  const out = new Map<string, CardLastRun>();
  for (const [key, info] of overview.cards) {
    const mine = local.get(key);
    const e = info.entry;
    if (mine && (!e || mine.at >= e.at)) {
      // A blocked or errored run here is not in the ledger; the ledger's verdict still stands beside it.
      out.set(key, { ...mine, fresh: mine.runId === e?.run ? info.state : e ? info.state : undefined, freshReasons: info.reasons });
    } else if (e) {
      out.set(key, { runId: e.run, status: e.result, at: e.at, perfIssues: 0, fresh: info.state, freshReasons: info.reasons, by: e.by, remote: !mine || mine.runId !== e.run });
    }
  }
  return out;
}

/**
 * One judgement per feature from everything Probe has seen: static unit coverage, the last
 * unit run, the cards, their last device runs, the navigation map and performance warnings.
 */
export function featureHealth(project: Project, scan: ScanResult): Map<string, FeatureHealth> {
  const runs = project.store.listRuns<Run>();
  const lastUnit = new Map<string, UnitRun>();
  for (const r of runs) if (r.kind === "unit" && r.status !== "running" && r.status !== "stopped" && !lastUnit.has(r.feature)) lastUnit.set(r.feature, r);
  const cards = listCards(project.root);
  const counts = countCards(cards);
  const overview = resultsOverview(project, scan);
  const lastRuns = cardResults(project, scan, overview);
  const nav = navMap(project);

  const out = new Map<string, FeatureHealth>();
  for (const f of scan.features) {
    const unitRun = lastUnit.get(f.id);
    const unitInfo: FreshInfo = overview.unit.get(f.id) ?? { state: "never", reasons: [] };
    const shared = unitInfo.entry;
    const unitAt = unitRun ? (unitRun.finishedAt ?? unitRun.startedAt) : "";
    const unit = unitRun && (!shared || unitAt >= shared.at)
      ? {
          runId: unitRun.id,
          status: unitRun.status,
          tests: unitRun.results.reduce((n, r) => n + r.tests, 0),
          failed: unitRun.results.reduce((n, r) => n + r.failed, 0),
          at: unitAt,
          fresh: unitInfo.state,
          freshReasons: unitInfo.reasons,
        }
      : shared
        ? { runId: shared.run, status: shared.result as RunStatus, tests: shared.tests ?? 0, failed: shared.failed ?? 0, at: shared.at, fresh: unitInfo.state, freshReasons: unitInfo.reasons, by: shared.by, remote: true }
        : null;
    const unitStale = unit?.fresh === "stale";

    const device = { passed: 0, failed: 0, blocked: 0, error: 0, notRun: 0, stale: 0, maybe: 0, lastAt: null as string | null };
    let perfIssues = 0;
    for (const c of cards.filter((x) => x.feature === f.id && x.status !== "rejected")) {
      const last = lastRuns.get(`${f.id}/${c.id}`);
      if (!last) {
        device.notRun++;
        continue;
      }
      // A verdict on code that has changed since is not a verdict on this code.
      if (last.fresh === "stale") device.stale++;
      else if (last.status === "passed" || last.status === "failed" || last.status === "blocked" || last.status === "error") device[last.status]++;
      if (last.fresh === "maybe") device.maybe++;
      perfIssues += last.perfIssues;
      if (!device.lastAt || last.at > device.lastAt) device.lastAt = last.at;
    }
    const navEntry = nav[f.id];

    const fail: string[] = [];
    const warn: string[] = [];
    if (unit?.status === "failed" && !unitStale) fail.push(`${unit.failed} unit test${unit.failed === 1 ? "" : "s"} failing`);
    if (unit?.status === "error" && !unitStale) fail.push("unit tests do not build or run");
    if (unitStale) warn.push(`unit result is outdated (${unit!.freshReasons.join(", ")})`);
    if (device.stale) warn.push(`${device.stale} card result${device.stale === 1 ? " is" : "s are"} outdated: the code or card changed since`);
    if (device.maybe) warn.push(`${device.maybe} card result${device.maybe === 1 ? "" : "s"} may be outdated: a module ${f.id} depends on changed`);
    if (device.failed) fail.push(`${device.failed} card${device.failed === 1 ? "" : "s"} failing on device`);
    if (navEntry?.issues.length) fail.push(`${navEntry.issues.length} navigation issue${navEntry.issues.length === 1 ? "" : "s"}`);
    if (device.blocked || device.error) warn.push(`${device.blocked + device.error} card run${device.blocked + device.error === 1 ? "" : "s"} blocked or errored`);
    if (perfIssues) warn.push(`${perfIssues} performance warning${perfIssues === 1 ? "" : "s"}`);
    if (f.stats.testable && f.stats.direct / f.stats.testable < 0.2) warn.push(`${Math.round((100 * f.stats.direct) / f.stats.testable)}% of classes have a test class`);
    if (f.group === "feature" && !counts.get(f.id)) warn.push("no feature cards");
    if (device.notRun) warn.push(`${device.notRun} card${device.notRun === 1 ? "" : "s"} never run on a device`);
    if (!unit && f.stats.testFiles) warn.push("unit tests never run");

    const seen = unit || device.passed + device.failed + device.blocked + device.error + device.stale > 0 || navEntry;
    const health: Health = fail.length ? "fail" : !seen ? "unknown" : warn.length ? "warn" : "ok";
    out.set(f.id, {
      health,
      reasons: [...fail, ...warn],
      unit,
      cards: counts.get(f.id) ?? null,
      device,
      nav: navEntry ? { screens: navEntry.screens.length, issues: navEntry.issues.length, at: navEntry.at } : null,
      perfIssues,
    });
  }
  return out;
}
