import { existsSync } from "node:fs";
import { join } from "node:path";
import { listCards } from "../cards/store.js";
import type { ScanResult } from "../core/types.js";
import { runTargets } from "../devices/driver.js";
import { cardResults, featureHealth } from "../engine/health.js";
import { changedFiles, defaultBase } from "../engine/history.js";
import { areaGraph, usedBy, uses } from "../engine/impact.js";
import { chosenFeatures, initPendingDrafts, initStatus, proposedAreas, undecidedAreas } from "../engine/init.js";
import type { Project } from "../engine/project.js";
import { findFeature, latestScan } from "../engine/scan.js";
import { featuresOfFiles } from "../engine/verify.js";
import { loadWatch } from "../engine/watch.js";
import { draftDiffs, listDrafts } from "../knowledge/draft.js";
import { briefGlance, checkManifest, loadManifest, loadManifests, manifestFile } from "../knowledge/manifest.js";
import { describeCardProof, ruleProofs } from "../knowledge/proof.js";
import { enrichAll } from "../tickets/inbox.js";
import type { TrackerTicket } from "../tickets/tracker.js";
import { branchInfo, setupChecklist } from "./project.js";

type KeptTicket = TrackerTicket & { source?: string; sourceLabel?: string };

/**
 * What Studio's slower pages show. Each runs git, reads every manifest or works out results
 * freshness, which takes seconds on a large repository, so Studio works them out on a worker
 * thread (viewWorker.ts): the page and every other request stay quick meanwhile.
 */
export const VIEWS = {
  branch: (project: Project, withBranches: boolean) => branchInfo(project, withBranches),
  setup: (project: Project) => setupChecklist(project),
  init: (project: Project) => ({
    steps: initStatus(project),
    // Each proposed feature or platform area, with whether it is chosen or not decided yet.
    proposed: project.store.read("scan.json") !== null ? proposedAreaRows(project) : [],
    chosen: chosenFeatures(project),
    drafts: initPendingDrafts(project).map((d) => ({ ...d, diffs: draftDiffs(project, d) })),
  }),
  scan: (project: Project) => summary(latestScan(project), project),
  cards: (project: Project) => {
    const last = cardResults(project, latestScan(project));
    return listCards(project.root).map((c) => ({ ...c, lastRun: last.get(`${c.feature}/${c.id}`) ?? null }));
  },
  changes: (project: Project, asked: string | null) => {
    const base = asked || defaultBase(project.root, project.config.verify.base);
    if (!base) return { base: null, files: [] as string[], features: [] as { feature: string; files: string[] }[], unowned: [] as string[] };
    const files = changedFiles(project.root, base);
    const { byFeature, unowned } = featuresOfFiles(project, latestScan(project), files);
    return { base, files, features: [...byFeature.entries()].map(([feature, fs]) => ({ feature, files: fs })), unowned };
  },
  inbox: (project: Project, tickets: KeptTicket[]) => enrichAll(project, tickets),
  knowledge: (project: Project, id: string) => {
    let manifest = null;
    try {
      manifest = loadManifest(project.root, id);
    } catch {
      // checkManifest below reports why it does not parse.
    }
    const exists = existsSync(join(project.root, manifestFile(id)));
    return {
      file: manifestFile(id),
      manifest,
      check: exists ? checkManifest(project.root, id) : null,
      glance: manifest ? briefGlance(project.root, manifest) : null,
      // Each rule's cards with their last result, keyed by rule id.
      cards: manifest
        ? Object.fromEntries(
            ruleProofs(project, manifest).map((p) => [
              p.invariant.id,
              p.cards.map((c) => ({ ref: c.ref, feature: c.feature, id: c.id, title: c.card?.title, status: c.card?.status, result: c.result, freshness: c.freshness, text: describeCardProof(c) })),
            ]),
          )
        : {},
      stale: loadWatch(project).stale[id] ?? null,
      kind: manifest?.kind ?? findFeature(latestScan(project), id)?.group ?? "feature",
      ...areaLinks(project, id),
      drafts: listDrafts(project, id).filter((d) => d.status === "pending").map((d) => ({ ...d, diffs: draftDiffs(project, d) })),
    };
  },
};

export type ViewName = keyof typeof VIEWS;
type ViewArg<N extends ViewName> = Parameters<(typeof VIEWS)[N]>[1];
export type ViewValue<N extends ViewName> = ReturnType<(typeof VIEWS)[N]>;

export function computeView<N extends ViewName>(project: Project, name: N, arg?: ViewArg<N>): ViewValue<N> {
  return (VIEWS[name] as (p: Project, a: unknown) => ViewValue<N>)(project, arg);
}

export function summary(result: ScanResult, project: Project) {
  const health = featureHealth(project, result);
  const manifests = new Map(loadManifests(project.root).map((m) => [m.id, m]));
  const graph = safeGraph(project, result);
  return {
    // Whether cards can run follows the settings (a web address set since the scan), not the scan.
    project: { ...result.project, devices: runTargets(project).length > 0 },
    scannedAt: result.scannedAt,
    excluded: result.excluded,
    features: result.features.map((f) => {
      const h = health.get(f.id)!;
      const m = manifests.get(f.id);
      return {
        id: f.id,
        group: f.group,
        stats: f.stats,
        ...h,
        lastUnitRun: h.unit ? { ...h.unit, id: h.unit.runId, finishedAt: h.unit.at } : null,
        // Its written knowledge at a glance: rules, and how many nothing proves yet.
        manifest: m ? { kind: m.kind, rules: m.invariants.length, unproven: m.invariants.filter((i) => !i.coveredBy.length && !i.cards.length).length } : null,
        usedBy: graph ? usedBy(graph, f.id).length : 0,
      };
    }),
  };
}

/** The module graph, or none when the build files cannot be read: Studio still shows the rest. */
function safeGraph(project: Project, result: ScanResult) {
  try {
    return areaGraph(project, result);
  } catch {
    return null;
  }
}

/** Which areas an area uses and which use it, from the build files. */
function areaLinks(project: Project, id: string): { usedBy: string[]; uses: string[] } {
  const graph = safeGraph(project, latestScan(project));
  return graph ? { usedBy: usedBy(graph, id), uses: uses(graph, id) } : { usedBy: [], uses: [] };
}

/** Proposed areas for Setup's picker: chosen ones ticked, undecided ones marked new. */
function proposedAreaRows(project: Project) {
  const chosen = new Set(chosenFeatures(project) ?? []);
  const undecided = new Set(undecidedAreas(project).map((a) => a.id));
  const written = new Set(loadManifests(project.root).map((m) => m.id));
  return proposedAreas(project).map((a) => ({ ...a, chosen: chosen.has(a.id), undecided: undecided.has(a.id), manifest: written.has(a.id) }));
}
