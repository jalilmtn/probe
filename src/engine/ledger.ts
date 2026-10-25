import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parse, stringify } from "yaml";
import { listCards } from "../cards/store.js";
import { CONFIG_DIR } from "../core/config.js";
import { capture } from "../core/proc.js";
import type { Card, CardRun, FeatureInfo, ModuleInfo, ScanResult, UnitRun } from "../core/types.js";
import { ContentIndex, type Fingerprint } from "./fingerprint.js";
import type { Project } from "./project.js";

/**
 * The shared record of results: `probe/results/<feature>.yaml`, committed with the code, so
 * whoever fetches sees what was tested, on which code, and whether it still holds for theirs.
 * Only a summary lives here; screenshots, video and logs stay on the machine that ran it.
 */
export interface LedgerEntry {
  result: "passed" | "failed" | "error";
  at: string;
  run: string;
  /** Code it ran on, for people; the fingerprint is what decides freshness. */
  commit?: string;
  dirty?: number;
  by?: string;
  device?: string;
  tests?: number;
  failed?: number;
  perf?: { startupMs?: number; jankyPct: number; p90Ms: number };
  fingerprint: Fingerprint;
}

export interface FeatureLedger {
  unit?: LedgerEntry;
  cards?: Record<string, LedgerEntry>;
}

export type Freshness = "fresh" | "stale" | "maybe" | "never";

export interface FreshInfo {
  state: Freshness;
  /** Why it is not fresh: what changed since the result was recorded. */
  reasons: string[];
  entry?: LedgerEntry;
}

const RESULTS_DIR = "results";

function ledgerFile(root: string, feature: string): string {
  return join(root, CONFIG_DIR, RESULTS_DIR, `${feature.replace(/:/g, "__")}.yaml`);
}

export function readLedger(root: string, feature: string): FeatureLedger {
  const file = ledgerFile(root, feature);
  return existsSync(file) ? ((parse(readFileSync(file, "utf8")) as FeatureLedger) ?? {}) : {};
}

function writeLedger(root: string, feature: string, ledger: FeatureLedger): void {
  mkdirSync(join(root, CONFIG_DIR, RESULTS_DIR), { recursive: true });
  // Sorted keys: two people recording different cards touch different lines.
  const cards = ledger.cards ? Object.fromEntries(Object.entries(ledger.cards).sort(([a], [b]) => a.localeCompare(b))) : undefined;
  writeFileSync(
    ledgerFile(root, feature),
    `# Probe results for "${feature}": written after each run, committed with the code.\n# A result is up to date while the code and card it ran on are unchanged.\n` +
      stringify({ ...(ledger.unit ? { unit: ledger.unit } : {}), ...(cards ? { cards } : {}) }, { lineWidth: 120 }),
  );
}

const gitUser = (root: string) => capture("git", ["config", "user.name"], root) ?? undefined;

/** The modules a card's result depends on: the ones it names, else its feature's. */
function cardModules(card: Card, feature: FeatureInfo | undefined): string[] {
  const known = new Set(feature?.modules.map((m) => m.id));
  const named = card.modules.filter((m) => known.has(m));
  return named.length ? named : (feature?.modules.map((m) => m.id) ?? []);
}

function allModules(scan: ScanResult): ModuleInfo[] {
  return scan.features.flatMap((f) => f.modules);
}

/** Taken when a run starts, so edits made while it runs do not count as tested. */
export function cardFingerprint(project: Project, scan: ScanResult, card: Card): Fingerprint {
  const feature = scan.features.find((f) => f.id === card.feature);
  return new ContentIndex(project, allModules(scan)).fingerprint(cardModules(card, feature), false, card);
}

export function unitFingerprint(project: Project, scan: ScanResult, featureId: string): Fingerprint {
  const feature = scan.features.find((f) => f.id === featureId);
  return new ContentIndex(project, allModules(scan)).fingerprint(feature?.modules.map((m) => m.id) ?? [], true);
}

/** Records a card run that judged the code. Blocked, errored and stopped runs say nothing about it. */
export function recordCardResult(project: Project, run: CardRun, fingerprint: Fingerprint): void {
  if (run.status !== "passed" && run.status !== "failed") return;
  const ledger = readLedger(project.root, run.feature);
  ledger.cards = {
    ...ledger.cards,
    [run.cardId]: {
      result: run.status,
      at: run.finishedAt ?? new Date().toISOString(),
      run: run.id,
      commit: run.git?.commit,
      dirty: run.git?.dirty || undefined,
      by: gitUser(project.root),
      device: run.device,
      perf: run.perf ? { startupMs: run.perf.startupMs, jankyPct: run.perf.jankyPct, p90Ms: run.perf.p90Ms } : undefined,
      fingerprint,
    },
  };
  writeLedger(project.root, run.feature, ledger);
}

/** A build that does not compile is a result too ("error"); a run with nothing to run is not. */
export function recordUnitResult(project: Project, run: UnitRun, fingerprint: Fingerprint): void {
  if (!["passed", "failed", "error"].includes(run.status) || (run.status === "error" && !/Build exited/.test(run.error ?? ""))) return;
  const ledger = readLedger(project.root, run.feature);
  ledger.unit = {
    result: run.status as LedgerEntry["result"],
    at: run.finishedAt ?? new Date().toISOString(),
    run: run.id,
    commit: run.git?.commit,
    dirty: run.git?.dirty || undefined,
    by: gitUser(project.root),
    tests: run.results.reduce((n, r) => n + r.tests, 0),
    failed: run.results.reduce((n, r) => n + r.failed, 0),
    fingerprint,
  };
  writeLedger(project.root, run.feature, ledger);
}

/**
 * Whether each recorded result still holds for the code checked out here: "fresh" when the
 * card and every module it ran on are unchanged, "stale" when one of them changed, "maybe"
 * when only modules they depend on changed, "never" without a result.
 */
export class ResultFreshness {
  private readonly index: ContentIndex;
  private readonly dirOf: Map<string, string>;

  constructor(private readonly project: Project, private readonly scan: ScanResult) {
    const modules = allModules(scan);
    this.index = new ContentIndex(project, modules);
    this.dirOf = new Map(modules.map((m) => [m.id, relative(project.root, m.dir).replace(/\\/g, "/")]));
  }

  card(card: Card, entry: LedgerEntry | undefined): FreshInfo {
    if (!entry) return { state: "never", reasons: [] };
    const feature = this.scan.features.find((f) => f.id === card.feature);
    return this.compare(entry, this.index.fingerprint(cardModules(card, feature), false, card));
  }

  unit(featureId: string, entry: LedgerEntry | undefined): FreshInfo {
    if (!entry) return { state: "never", reasons: [] };
    const feature = this.scan.features.find((f) => f.id === featureId);
    return this.compare(entry, this.index.fingerprint(feature?.modules.map((m) => m.id) ?? [], true));
  }

  private compare(entry: LedgerEntry, now: Fingerprint): FreshInfo {
    const was = entry.fingerprint;
    const reasons: string[] = [];
    if (was.card !== undefined && was.card !== now.card) reasons.push("the card changed");
    for (const [id, hash] of Object.entries(now.own)) {
      if (was.own?.[id] === undefined) reasons.push(`${id} was not part of it`);
      else if (was.own[id] !== hash) reasons.push(`${id} changed`);
    }
    if (reasons.length) return { state: "stale", reasons, entry };
    if (was.deps !== now.deps) return { state: "maybe", reasons: [this.depsChanged(entry, Object.keys(now.own))], entry };
    return { state: "fresh", reasons: [], entry };
  }

  /** Names the dependencies that changed when the recorded commit is here to compare with. */
  private depsChanged(entry: LedgerEntry, own: string[]): string {
    const deps = this.index.dependenciesOf(own);
    const dirs = deps.map((d) => this.dirOf.get(d)).filter((d): d is string => !!d);
    const out = entry.commit && dirs.length && dirs.length <= 60 ? capture("git", ["diff", "--name-only", entry.commit, "--", ...dirs], this.project.root) : null;
    if (out === null) return "a module it depends on changed";
    const changed = deps.filter((d) => {
      const dir = this.dirOf.get(d);
      return dir && out.split("\n").some((f) => f.startsWith(`${dir}/`));
    });
    return changed.length ? `dependency changed: ${changed.slice(0, 4).join(", ")}${changed.length > 4 ? ` +${changed.length - 4}` : ""}` : "a module it depends on changed";
  }
}

/** Every card's and feature's result with its freshness, for health, Studio and verify. */
export function resultsOverview(project: Project, scan: ScanResult) {
  const fresh = new ResultFreshness(project, scan);
  const cards = new Map<string, FreshInfo>();
  const unit = new Map<string, FreshInfo>();
  for (const f of scan.features) {
    const ledger = readLedger(project.root, f.id);
    unit.set(f.id, fresh.unit(f.id, ledger.unit));
    for (const c of listCards(project.root, f.id)) cards.set(`${f.id}/${c.id}`, fresh.card(c, ledger.cards?.[c.id]));
  }
  return { cards, unit };
}
