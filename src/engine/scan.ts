import { isExcluded } from "../core/config.js";
import { isTestable } from "../core/kinds.js";
import type { FeatureInfo, ModuleInfo, ScanResult } from "../core/types.js";
import type { Project } from "./project.js";

const SCAN_FILE = "scan.json";

export function scan(project: Project): ScanResult {
  const modules = project.adapter.scanModules(project.root, project.config);
  const groups = new Map<string, { group: FeatureInfo["group"]; modules: ModuleInfo[] }>();
  const excluded = new Set<string>();

  for (const m of modules) {
    const { id, group } = m.feature ?? featureOf(m.id, project.config.features.roots);
    if (isExcluded(project.config, id, m.id)) {
      excluded.add(id);
      continue;
    }
    const entry = groups.get(id) ?? { group, modules: [] };
    entry.modules.push(m);
    groups.set(id, entry);
  }

  const features = [...groups.entries()]
    .map(([id, { group, modules: ms }]) => ({ id, group, modules: ms, stats: stats(ms) }))
    .sort((a, b) => (a.group === b.group ? a.id.localeCompare(b.id) : a.group === "feature" ? -1 : 1));

  const result: ScanResult = {
    project: { root: project.root, name: project.name, adapter: project.adapter.id, devices: project.adapter.supportsDevices },
    scannedAt: new Date().toISOString(),
    features,
    excluded: [...excluded].sort(),
  };
  project.store.write(SCAN_FILE, result);
  return result;
}

/** Last scan, or a fresh one when there is none yet. */
export function latestScan(project: Project): ScanResult {
  return project.store.read<ScanResult>(SCAN_FILE) ?? scan(project);
}

export function findFeature(result: ScanResult, id: string): FeatureInfo | undefined {
  return result.features.find((f) => f.id === id) ?? result.features.find((f) => f.id.toLowerCase() === id.toLowerCase());
}

/** `:feature:chat:impl` → "chat"; `:core:network:api` → "core:network"; `:app` → "app". */
function featureOf(moduleId: string, roots: string[]): { id: string; group: FeatureInfo["group"] } {
  const [first, second] = moduleId.slice(1).split(":");
  if (first && roots.includes(first)) return { id: second ?? first, group: "feature" };
  return { id: second ? `${first}:${second}` : first!, group: "platform" };
}

function stats(modules: ModuleInfo[]): FeatureInfo["stats"] {
  const testable = modules.flatMap((m) => m.classes).filter(isTestable);
  return {
    modules: modules.length,
    classes: modules.reduce((n, m) => n + m.classes.length, 0),
    testable: testable.length,
    direct: testable.filter((c) => c.test === "direct").length,
    referenced: testable.filter((c) => c.test === "referenced").length,
    untested: testable.filter((c) => c.test === "none").length,
    testFiles: modules.reduce((n, m) => n + m.testFiles, 0),
  };
}

/** Untested classes in a feature, most worth testing first. */
export function riskyGaps(feature: FeatureInfo, limit = 25) {
  return feature.modules
    .flatMap((m) => m.classes.map((c) => ({ ...c, module: m.id })))
    .filter((c) => c.test === "none" && isTestable(c))
    .sort((a, b) => b.risk - a.risk)
    .slice(0, limit);
}
