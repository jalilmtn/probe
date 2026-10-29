import { relative } from "node:path";
import type { ScanResult } from "../core/types.js";
import type { Project } from "./project.js";

/**
 * Who builds on whom, between the scan's areas (features and platform areas). An edit in a
 * platform module is an edit to code its dependents run, so it makes them stale too; how far
 * that reaches is `watch.impactDepth` (1: direct dependents only, 0: off).
 */
export interface AreaGraph {
  /** Area id of each module id. */
  areaOf: Map<string, string>;
  /** Module ids each module id depends on directly. */
  deps: Map<string, string[]>;
  /** Module ids that depend directly on each module id. */
  dependents: Map<string, string[]>;
  /** Module ids of each area. */
  modulesOf: Map<string, string[]>;
  /** Module dirs, repo relative with a trailing slash, longest first. */
  dirs: { module: string; dir: string }[];
}

/** One build-file pass serves a burst of edits; a hook process is gone long before it ages. */
let cached: { root: string; scannedAt: string; at: number; graph: AreaGraph } | null = null;

export function areaGraph(project: Project, result: ScanResult): AreaGraph {
  if (cached && cached.root === project.root && cached.scannedAt === result.scannedAt && Date.now() - cached.at < 5000) return cached.graph;
  const graph = buildGraph(project.root, result, project.adapter.moduleDependencies(project.root));
  cached = { root: project.root, scannedAt: result.scannedAt, at: Date.now(), graph };
  return graph;
}

export function buildGraph(root: string, result: ScanResult, deps: Map<string, string[]>): AreaGraph {
  const areaOf = new Map<string, string>();
  const modulesOf = new Map<string, string[]>();
  const dirs: AreaGraph["dirs"] = [];
  for (const f of result.features) {
    modulesOf.set(f.id, f.modules.map((m) => m.id));
    for (const m of f.modules) {
      areaOf.set(m.id, f.id);
      dirs.push({ module: m.id, dir: `${relative(root, m.dir).replace(/\\/g, "/")}/` });
    }
  }
  dirs.sort((a, b) => b.dir.length - a.dir.length);
  const dependents = new Map<string, string[]>();
  for (const [module, uses] of deps) for (const used of uses) dependents.set(used, [...(dependents.get(used) ?? []), module]);
  return { areaOf, deps, dependents, modulesOf, dirs };
}

export function moduleOfFile(graph: AreaGraph, file: string): string | undefined {
  return graph.dirs.find((d) => file.startsWith(d.dir))?.module;
}

/**
 * The areas that depend on a module, up to `depth` steps away, each with its distance. The
 * module's own area is never among them: it owns the change. Steps count between areas, not
 * modules, so `:a:impl` depending on `:a:api` inside one area costs nothing.
 */
export function dependentAreas(graph: AreaGraph, module: string, depth: number): Map<string, number> {
  const own = graph.areaOf.get(module);
  const out = new Map<string, number>();
  let frontier = [module];
  for (let step = 1; step <= depth && frontier.length; step++) {
    const reached = new Set<string>();
    for (const m of frontier) {
      for (const user of graph.dependents.get(m) ?? []) {
        const area = graph.areaOf.get(user);
        if (!area || area === own || out.has(area)) continue;
        out.set(area, step);
        reached.add(area);
      }
    }
    frontier = [...reached].flatMap((a) => graph.modulesOf.get(a) ?? []);
  }
  return out;
}

/** Areas a whole area's modules feed, directly: what a platform area is used by. */
export function usedBy(graph: AreaGraph, area: string): string[] {
  const out = new Set<string>();
  for (const m of graph.modulesOf.get(area) ?? []) for (const a of dependentAreas(graph, m, 1).keys()) out.add(a);
  return [...out].sort();
}

/** Areas an area's modules use directly. */
export function uses(graph: AreaGraph, area: string): string[] {
  const out = new Set<string>();
  for (const m of graph.modulesOf.get(area) ?? []) for (const d of graph.deps.get(m) ?? []) {
    const a = graph.areaOf.get(d);
    if (a && a !== area) out.add(a);
  }
  return [...out].sort();
}
