import { spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { ignoredPathPattern } from "../adapters/adapter.js";
import { isWindows, throwIfStopped } from "../core/proc.js";
import { newRunId } from "../core/store.js";
import type { CheckFeature, CheckRun, ScanResult } from "../core/types.js";
import { draftCorrections, listDrafts } from "../knowledge/draft.js";
import { checkManifest, loadManifest, loadManifests, manifestFile } from "../knowledge/manifest.js";
import { describeCardProof, ruleProofs } from "../knowledge/proof.js";
import { dirtyFiles } from "./history.js";
import type { Project } from "./project.js";
import { launchRun, liveRun } from "./runs.js";
import { findFeature, latestScan } from "./scan.js";
import { startUnitRun } from "./unit.js";
import { areaGraph, dependentAreas, moduleOfFile } from "./impact.js";
import { featuresOfFiles } from "./verify.js";

/**
 * Keeping features current while people code. An edit marks the features it touches stale
 * (instant, no build); a check then runs their unit tests, checks their manifest's test links
 * and has an agent draft corrections for review. Results go back to the coding-agent session
 * whose edits caused them.
 */

/**
 * Who reported an edit: a coding-agent hook, a git pre-commit hook, the IDE file watcher, or a
 * person. `claude` remains readable for watch state written by older Probe versions.
 */
export type ChangeSource = "claude" | "agent" | "commit" | "editor" | "manual";

export interface StaleEntry {
  files: string[];
  /** True when the feature owns a changed file; false when it only depends on one. */
  owned: boolean;
  /** Platform areas whose edits reached it through the module graph, not through a file it owns. */
  dependsOn?: string[];
  since: string;
  last: string;
  sources: ChangeSource[];
  /** Agent sessions whose edits made it stale, so their results go back to them. */
  sessions: string[];
}

/** One feature's check, kept so it can be reported to the sessions that caused it. */
export interface CheckRecord {
  runId: string;
  feature: string;
  at: string;
  unit?: string;
  failures: string[];
  broken: number;
  gaps: number;
  draftId?: string;
  deviceRules?: string[];
  note?: string;
  sessions: string[];
  reportedTo: string[];
}

interface WatchState {
  stale: Record<string, StaleEntry>;
  checks: CheckRecord[];
  /** Last time the turn-end sweep looked at uncommitted files. */
  sweptAt?: string;
}

const STATE = "watch.json";
const LOCK = "check.lock";
const STUDIO = "studio.json";

export function loadWatch(project: Project): WatchState {
  return { stale: {}, checks: [], ...(project.store.read<WatchState>(STATE) ?? {}) };
}

/** Atomic, so a hook and Studio writing at once never leave half a file. */
function saveWatch(project: Project, state: WatchState): void {
  const file = join(project.store.dir, STATE);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...state, checks: state.checks.slice(-100) }, null, 2));
  renameSync(tmp, file);
}

function update(project: Project, change: (state: WatchState) => void): WatchState {
  const state = loadWatch(project);
  change(state);
  saveWatch(project, state);
  return state;
}

/** Repo-relative forward-slash paths of the files that can belong to a feature. */
function projectFiles(project: Project, files: string[]): string[] {
  const ignored = ignoredPathPattern(project.adapter);
  return files
    .map((f) => relative(project.root, isAbsolute(f) ? f : resolve(project.root, f)).replace(/\\/g, "/"))
    .filter((f) => f && !f.startsWith("..") && !ignored.test(f) && !f.startsWith("probe/"));
}

/**
 * The features a set of files touches: owned through the scan's modules or a manifest's
 * `paths`; related through a manifest's `related`, or by depending on an edited platform module
 * (up to `watch.impactDepth` steps away), which names that area in `dependsOn`.
 */
export function featuresForFiles(project: Project, files: string[], result: ScanResult = latestScan(project)): Map<string, Touched> {
  const out = new Map<string, Touched>();
  const add = (feature: string, file: string, owned: boolean, via?: string) => {
    const entry = out.get(feature) ?? { files: [], owned: false, dependsOn: [] };
    if (!entry.files.includes(file)) entry.files.push(file);
    entry.owned ||= owned;
    if (via && !entry.dependsOn.includes(via)) entry.dependsOn.push(via);
    out.set(feature, entry);
  };
  for (const [feature, fs] of featuresOfFiles(project, result, files).byFeature) for (const f of fs) add(feature, f, true);
  for (const m of loadManifests(project.root)) {
    for (const f of files) {
      if (m.paths.some((p) => f.startsWith(p))) add(m.id, f, true);
      else if (m.related.some((r) => f.startsWith(r.path))) add(m.id, f, false);
    }
  }
  const depth = project.config.watch?.impactDepth ?? 1;
  const platform = new Set(result.features.filter((f) => f.group === "platform").map((f) => f.id));
  if (depth > 0 && [...out].some(([id, e]) => e.owned && platform.has(id))) {
    const graph = areaGraph(project, result);
    for (const f of files) {
      const module = moduleOfFile(graph, f);
      const area = module && graph.areaOf.get(module);
      if (!module || !area || !platform.has(area)) continue;
      for (const dependent of dependentAreas(graph, module, depth).keys()) add(dependent, f, false, area);
    }
  }
  return out;
}

export interface Touched {
  files: string[];
  owned: boolean;
  /** Edited platform areas it depends on, when that is how the files reached it. */
  dependsOn: string[];
}

/** Marks the features these files touch as stale. Cheap: no build, no git. Returns their ids. */
export function markStale(project: Project, files: string[], source: ChangeSource, session?: string): string[] {
  const rel = projectFiles(project, files);
  if (!rel.length) return [];
  const touched = featuresForFiles(project, rel);
  if (!touched.size) return [];
  const now = new Date().toISOString();
  update(project, (state) => {
    for (const [feature, { files: fs, owned, dependsOn }] of touched) {
      const e = state.stale[feature] ?? { files: [], owned: false, since: now, last: now, sources: [], sessions: [] };
      e.files = [...new Set([...e.files, ...fs])];
      e.owned ||= owned;
      if (dependsOn.length) e.dependsOn = [...new Set([...(e.dependsOn ?? []), ...dependsOn])];
      e.last = now;
      if (!e.sources.includes(source)) e.sources.push(source);
      if (session && !e.sessions.includes(session)) e.sessions.push(session);
      state.stale[feature] = e;
    }
  });
  return [...touched.keys()];
}

/**
 * Catches what the edit hook cannot see (a shell command, an IDE open alongside): uncommitted
 * files modified since the last sweep. The first sweep only sets the mark, so a branch full of
 * old uncommitted work does not make everything stale at once.
 */
export function sweepDirty(project: Project, source: ChangeSource, session?: string): string[] {
  const state = loadWatch(project);
  const since = state.sweptAt ? Date.parse(state.sweptAt) : null;
  const now = new Date().toISOString();
  update(project, (s) => (s.sweptAt = now));
  if (since === null) return [];
  const recent = [...dirtyFiles(project.root).keys()].filter((f) => {
    try {
      return statSync(join(project.root, f)).mtimeMs > since;
    } catch {
      return false; // deleted
    }
  });
  return markStale(project, recent, source, session);
}

// ── The check ────────────────────────────────────────────────────────────────

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The check running now, in this process or another, if any. */
export function runningCheck(project: Project): { pid: number; runId: string; startedAt: string } | null {
  const lock = project.store.read<{ pid: number; runId: string; startedAt: string }>(LOCK);
  return lock && alive(lock.pid) ? lock : null;
}

export interface CheckOptions {
  /** Only these features (stale or not); every stale feature when absent. */
  features?: string[];
  trigger?: ChangeSource;
  /** Override watch.drafts. */
  drafts?: boolean;
  model?: string;
}

/**
 * Checks the stale features: unit tests, manifest links, then a drafted correction for each
 * owned feature with a manifest. One check at a time per project, across processes; edits made
 * while it runs are picked up by another round before it ends.
 */
export function startCheck(project: Project, options: CheckOptions = {}): { run: CheckRun; done: Promise<CheckRun> } | null {
  if (runningCheck(project)) return null;
  const run: CheckRun = {
    id: newRunId(),
    kind: "check",
    feature: options.features?.length === 1 ? options.features[0]! : "*",
    startedAt: new Date().toISOString(),
    status: "running",
    trigger: options.trigger ?? "manual",
    features: [],
    skipped: [],
    costUsd: 0,
  };
  project.store.write(LOCK, { pid: process.pid, runId: run.id, startedAt: run.startedAt });

  const started = launchRun(project, run, async (log) => {
    try {
      // Rounds: edits that land while a round runs make their features stale again.
      for (let round = 0; round < 3; round++) {
        const checkedAt = new Date().toISOString();
        const targets = pickTargets(project, options, run, round);
        if (!targets.length) break;
        log(`── round ${round + 1}: ${targets.map((t) => t.feature).join(", ")}${run.skipped.length ? ` (left for later: ${run.skipped.join(", ")})` : ""}`);
        for (const t of targets) {
          throwIfStopped();
          await checkFeature(project, run, t, options, log);
          clearStale(project, t.feature, checkedAt);
        }
        if (options.features?.length) break;
      }
      const failed = run.features.some((f) => f.unitStatus === "failed" || (f.manifest?.broken ?? 0) > 0);
      const errored = run.features.some((f) => f.unitStatus === "error");
      run.status = !run.features.length ? "passed" : failed ? "failed" : errored ? "error" : "passed";
      if (run.status === "error") run.error = `The build failed before the tests ran: ${run.features.filter((f) => f.unitStatus === "error").map((f) => f.feature).join(", ")}.`;
      if (!run.features.length) log("nothing stale to check");
    } finally {
      rmSync(join(project.store.dir, LOCK), { force: true });
    }
  });
  return started;
}

type Target = { feature: string; files: string[]; owned: boolean; dependsOn?: string[]; sessions: string[] };

function pickTargets(project: Project, options: CheckOptions, run: CheckRun, round: number): Target[] {
  const state = loadWatch(project);
  if (options.features?.length) {
    if (round > 0) return [];
    return options.features.map((f) => ({ feature: f, files: state.stale[f]?.files ?? [], owned: state.stale[f]?.owned ?? true, sessions: state.stale[f]?.sessions ?? [] }));
  }
  // Owned before related, then the most changed files first. Features over the budget stay
  // stale for the next check rather than starting a pile of builds and agents now.
  const entries = Object.entries(state.stale)
    .filter(([id]) => !run.skipped.includes(id))
    .sort(([, a], [, b]) => Number(b.owned) - Number(a.owned) || b.files.length - a.files.length);
  const budget = Math.max(1, project.config.watch.maxFeatures);
  if (round === 0) run.skipped = entries.slice(budget).map(([id]) => id);
  return entries.slice(0, budget).map(([feature, e]) => ({ feature, files: e.files, owned: e.owned, dependsOn: e.dependsOn, sessions: e.sessions }));
}

async function checkFeature(
  project: Project,
  run: CheckRun,
  target: Target,
  options: CheckOptions,
  log: (line: string) => void,
): Promise<void> {
  const f: CheckFeature = { feature: target.feature, files: target.files, owned: target.owned, ...(target.dependsOn?.length && !target.owned ? { dependsOn: target.dependsOn } : {}), failures: [] };
  run.features.push(f);

  // Unit tests, when the scan knows modules with tests for it.
  const scanned = findFeature(latestScan(project), target.feature);
  if (scanned?.modules.some((m) => m.unitTestTask)) {
    const { run: unit, done } = startUnitRun(project, scanned.id);
    f.unitRun = unit.id;
    log(`${target.feature}: unit tests (run ${unit.id})`);
    const finished = await done;
    f.unitStatus = finished.status;
    f.failures = finished.results.flatMap((r) => r.failures.map((x) => `${x.className.split(".").pop()}.${x.name}: ${(x.message ?? "").split("\n")[0]!.slice(0, 200)}`)).slice(0, 8);
    // A build that never reached the tests: its compiler errors are the failure.
    if (finished.status === "error") {
      const compile = (liveRun(unit.id)?.log ?? []).filter((l) => /^e: /.test(l)).map((l) => l.replace(/^e: file:\/\/\/?/, "compile error: ").replace(project.root.replace(/\\/g, "/") + "/", ""));
      f.failures = compile.length ? compile.slice(0, 5) : [finished.error ?? "build failed"];
    }
    const total = finished.results.reduce((n, r) => n + r.tests, 0);
    log(`${target.feature}: unit ${finished.status}, ${total} tests${f.failures.length ? `, ${f.failures.length} failing` : ""}`);
  } else {
    f.unitStatus = "skipped";
    f.note = scanned ? "no unit tests" : "not a module feature; only its manifest is checked";
  }

  // Manifest links, and a drafted correction for an owned feature.
  const manifest = (() => {
    try {
      return loadManifest(project.root, target.feature);
    } catch {
      return null;
    }
  })();
  const check = existsSync(join(project.root, manifestFile(target.feature))) ? checkManifest(project.root, target.feature) : null;
  if (check) {
    const broken = check.broken.length + check.brokenCards.length;
    f.manifest = { links: check.links + check.cardLinks, broken, gaps: check.gaps.length, errors: check.errors.length };
    log(`${target.feature}: manifest ${check.links} test links, ${check.cardLinks} card links, ${broken} broken, ${check.gaps.length} unproven`);
  }
  // Unit tests cannot speak for a rule only a card proves: name it, so the change gets a device run.
  if (manifest && target.owned && target.files.length) {
    try {
      const rules = ruleProofs(project, manifest)
        .filter((p) => !p.invariant.coveredBy.length && p.cards.length)
        .filter((p) => !p.cards.every((c) => c.result === "passed" && c.freshness === "fresh"))
        .map((p) => `${p.feature}/${p.invariant.id} (${p.cards.map(describeCardProof).join("; ")})`);
      if (rules.length) {
        f.deviceRules = rules;
        log(`${target.feature}: ${rules.length} rule(s) only a device card proves`);
      }
    } catch (e) {
      log(`${target.feature}: could not read card results (${(e as Error).message})`);
    }
  }
  const drafts = options.drafts ?? project.config.watch.drafts;
  const hasPending = listDrafts(project, target.feature).some((d) => d.status === "pending");
  if (manifest && check && drafts && target.owned && target.files.length && !hasPending) {
    throwIfStopped();
    const unit = f.unitStatus === "skipped" ? `not run (${f.note})` : `${f.unitStatus}${f.failures.length ? `\n${f.failures.map((x) => `- ${x}`).join("\n")}` : ""}`;
    const { draft, costUsd } = await draftCorrections(project, { manifest, check, files: target.files, unit, runId: run.id, model: options.model }, log);
    run.costUsd += costUsd;
    if (draft) f.draftId = draft.id;
  } else if (hasPending) {
    log(`${target.feature}: a draft is already waiting for review; not drafting another`);
  }

  update(project, (state) =>
    state.checks.push({
      runId: run.id,
      feature: f.feature,
      at: new Date().toISOString(),
      unit: f.unitStatus,
      failures: f.failures,
      broken: f.manifest?.broken ?? 0,
      gaps: f.manifest?.gaps ?? 0,
      draftId: f.draftId,
      deviceRules: f.deviceRules,
      note: f.note,
      sessions: target.sessions,
      reportedTo: [],
    }),
  );
}

/** Drops a feature's stale mark unless an edit landed after its check began. */
function clearStale(project: Project, feature: string, checkedAt: string): void {
  update(project, (state) => {
    const e = state.stale[feature];
    if (e && e.last <= checkedAt) delete state.stale[feature];
  });
}

/** How a feature that owns none of the changed files was reached. */
export function staleLabel(e: { owned: boolean; dependsOn?: string[] }): string {
  if (e.owned) return "";
  return e.dependsOn?.length ? ` (depends on ${e.dependsOn.join(", ")})` : " (related)";
}

export function summarizeCheckRun(run: CheckRun): string {
  const lines = [`Check ${run.id} · ${run.trigger} · ${run.status.toUpperCase()} · ${run.features.length} features · $${run.costUsd.toFixed(2)}`];
  if (run.error) lines.push(run.error);
  for (const f of run.features) {
    lines.push(`  ${f.feature}${staleLabel(f)}: unit ${f.unitStatus ?? "—"}${f.unitRun ? ` (${f.unitRun})` : ""}${f.manifest ? ` · manifest ${f.manifest.broken} broken links, ${f.manifest.gaps} unproven` : ""}${f.draftId ? ` · draft ${f.draftId} to review` : ""}${f.note ? ` · ${f.note}` : ""}`);
    for (const x of f.failures) lines.push(`      - ${x}`);
    for (const r of f.deviceRules ?? []) lines.push(`      device: ${r}`);
  }
  if (run.skipped.length) lines.push(`  left stale (over watch.maxFeatures): ${run.skipped.join(", ")}`);
  return lines.join("\n");
}

// ── Starting a check from a hook ─────────────────────────────────────────────

/** Studio writes where it listens, so a hook can hand it the check and its live log. */
export function recordStudio(project: Project, url: string): void {
  project.store.write(STUDIO, { url, pid: process.pid });
}

/**
 * Starts a check without waiting for it: in Studio when it is running (the log shows live
 * there), otherwise in a detached Probe process that outlives the hook.
 */
export async function kickCheck(project: Project, trigger: ChangeSource): Promise<"studio" | "background" | "busy"> {
  if (runningCheck(project)) return "busy";
  const studio = project.store.read<{ url: string; pid: number }>(STUDIO);
  if (studio && alive(studio.pid)) {
    try {
      const res = await fetch(`${studio.url}/api/watch/check`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ trigger }), signal: AbortSignal.timeout(1500) });
      if (res.ok) return "studio";
    } catch {
      // Studio went away: fall through to a background process.
    }
  }
  const child = spawn(process.execPath, [resolve(process.argv[1]!), "check", "--trigger", trigger, "--project", project.root], {
    cwd: project.root,
    detached: true,
    stdio: "ignore",
    windowsHide: isWindows,
  });
  child.unref();
  return "background";
}

// ── Reporting back to the agent session ──────────────────────────────────────

/**
 * Checks this session has not been told about yet: the ones its own edits caused, and the ones
 * edits outside this session caused. Marks them reported.
 */
export function takeReports(project: Project, session: string, filter: (r: CheckRecord) => boolean = () => true): CheckRecord[] {
  let taken: CheckRecord[] = [];
  update(project, (state) => {
    taken = state.checks.filter((r) => !r.reportedTo.includes(session) && (r.sessions.includes(session) || r.sessions.length === 0) && filter(r));
    for (const r of taken) r.reportedTo.push(session);
  });
  return taken;
}

export function isProblem(r: CheckRecord): boolean {
  return r.unit === "failed" || r.unit === "error" || r.broken > 0;
}

export function formatReports(reports: CheckRecord[], studioUrl?: string): string {
  const lines = ["Probe checked the features your recent edits touched:"];
  for (const r of reports) {
    const parts = [`unit ${r.unit ?? "not run"}`];
    if (r.broken) parts.push(`${r.broken} manifest link${r.broken === 1 ? "" : "s"} broken (a test or card was renamed or removed)`);
    if (r.draftId) parts.push(`a correction to its manifest/brief is drafted for review${studioUrl ? ` in Studio (${studioUrl})` : ""}`);
    lines.push(`- ${r.feature}: ${parts.join("; ")}${r.note ? ` (${r.note})` : ""}`);
    for (const x of r.failures) lines.push(`    failing: ${x}`);
    if (r.deviceRules?.length) {
      lines.push(`    only a device proves ${r.deviceRules.length === 1 ? "this rule" : "these rules"}; unit tests say nothing about ${r.deviceRules.length === 1 ? "it" : "them"}:`);
      for (const d of r.deviceRules) lines.push(`      ${d}`);
    }
  }
  if (reports.some(isProblem)) lines.push("Fix the failures before going on, or say why they are expected. `probe check <feature>` re-checks.");
  if (reports.some((r) => r.deviceRules?.length))
    lines.push("Offer to run those rules' cards on an emulator (probe_card_run with rule: \"feature/rule\"; minutes per card). Do not start one unasked.");
  return lines.join("\n");
}

export function studioUrl(project: Project): string | undefined {
  const s = project.store.read<{ url: string; pid: number }>(STUDIO);
  return s && alive(s.pid) ? s.url : undefined;
}
