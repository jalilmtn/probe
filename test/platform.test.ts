import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { loadConfig } from "../src/core/config.js";
import { Store } from "../src/core/store.js";
import type { FeatureInfo, ModuleInfo, ScanResult } from "../src/core/types.js";
import { buildGraph, dependentAreas, usedBy, uses } from "../src/engine/impact.js";
import { chooseFeatures, chosenFeatures, initStatus, proposedAreas, undecidedAreas } from "../src/engine/init.js";
import type { Project } from "../src/engine/project.js";
import { featuresForFiles, loadWatch, markStale, staleLabel } from "../src/engine/watch.js";
import { checkManifest, loadManifests, manifestFile, manifestIdOf } from "../src/knowledge/manifest.js";

// The store lives under the home folder: point it at a scratch one.
const home = mkdtempSync(join(tmpdir(), "probe-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;

/**
 * A small app: chat and profile features, a core:database platform area that both use, a
 * core:network area that core:database uses, and core:resources with no code at all.
 */
const MODULES: Record<string, { area: string; group: FeatureInfo["group"]; dir: string; testable: number; deps: string[] }> = {
  ":feature:chat:impl": { area: "chat", group: "feature", dir: "feature/chat/impl", testable: 4, deps: [":feature:chat:api", ":core:database"] },
  ":feature:chat:api": { area: "chat", group: "feature", dir: "feature/chat/api", testable: 1, deps: [] },
  ":feature:profile:impl": { area: "profile", group: "feature", dir: "feature/profile/impl", testable: 3, deps: [":core:database", ":feature:chat:api"] },
  ":core:database": { area: "core:database", group: "platform", dir: "core/database", testable: 5, deps: [":core:network:api"] },
  ":core:network:api": { area: "core:network", group: "platform", dir: "core/network/api", testable: 0, deps: [] },
  ":core:network:impl": { area: "core:network", group: "platform", dir: "core/network/impl", testable: 6, deps: [":core:network:api"] },
  ":core:resources": { area: "core:resources", group: "platform", dir: "core/resources", testable: 0, deps: [] },
  ":app": { area: "app", group: "platform", dir: "app", testable: 2, deps: [":feature:chat:impl", ":feature:profile:impl", ":core:network:impl"] },
};

function scanOf(root: string): ScanResult {
  const areas = new Map<string, FeatureInfo>();
  for (const [id, m] of Object.entries(MODULES)) {
    const module: ModuleInfo = { id, dir: join(root, m.dir), mainFiles: m.testable, testFiles: m.testable ? 1 : 0, unitTestTask: null, classes: [] } as unknown as ModuleInfo;
    const area = areas.get(m.area) ?? { id: m.area, group: m.group, modules: [], stats: { modules: 0, classes: 0, testable: 0, direct: 0, referenced: 0, untested: 0, testFiles: 0 } };
    area.modules.push(module);
    area.stats.modules++;
    area.stats.testable += m.testable;
    area.stats.testFiles += module.testFiles;
    areas.set(m.area, area);
  }
  return { project: { root, name: "fake", adapter: "fake" }, scannedAt: new Date().toISOString(), features: [...areas.values()], excluded: [] } as ScanResult;
}

const DEPS = new Map(Object.entries(MODULES).map(([id, m]) => [id, m.deps]));

function fakeProject(impactDepth?: number): Project {
  const root = mkdtempSync(join(tmpdir(), "probe-project-"));
  for (const m of Object.values(MODULES)) mkdirSync(join(root, m.dir), { recursive: true });
  if (impactDepth !== undefined) {
    mkdirSync(join(root, "probe"), { recursive: true });
    writeFileSync(join(root, "probe", "probe.yaml"), `watch:\n  impactDepth: ${impactDepth}\n`);
  }
  const store = new Store(root);
  const adapter = { id: "fake", label: "Fake", supportsDevices: false, ignoredDirs: [], moduleDependencies: () => DEPS, doctor: () => [], detectApp: () => null } as unknown as Project["adapter"];
  const project: Project = { root, name: "fake", adapter, config: loadConfig(root, store.dir), store };
  store.write("scan.json", scanOf(root));
  return project;
}

function writeManifest(project: Project, id: string, body: string): void {
  mkdirSync(join(project.root, "probe", "features"), { recursive: true });
  writeFileSync(join(project.root, manifestFile(id)), body);
}

describe("platform manifests", () => {
  test("a platform id is stored with __ for the colon and read back by its id", () => {
    assert.equal(manifestFile("core:database"), "probe/features/core__database.yaml");
    assert.equal(manifestIdOf("core__database.yaml"), "core:database");
    assert.equal(manifestIdOf("probe/features/chat.yaml"), "chat");
  });

  test("kind reads as platform when written so, and as feature when left out", () => {
    const project = fakeProject();
    writeManifest(project, "core:database", "id: core:database\nkind: platform\nsummary: Room database.\n");
    writeManifest(project, "chat", "id: chat\nsummary: Messages.\n");
    const byId = new Map(loadManifests(project.root).map((m) => [m.id, m]));
    assert.equal(byId.get("core:database")?.kind, "platform");
    assert.equal(byId.get("chat")?.kind, "feature");
  });

  test("the check accepts a platform manifest and rejects an unknown kind", () => {
    const project = fakeProject();
    writeManifest(project, "core:database", "id: core:database\nkind: platform\nsummary: Room database.\n");
    assert.deepEqual(checkManifest(project.root, "core:database").errors, []);
    const bad = checkManifest(project.root, "core:database", "id: core:database\nkind: library\nsummary: x\n");
    assert.ok(bad.errors.some((e) => e.includes('kind is "library"')), bad.errors.join("; "));
  });
});

describe("impact through the module graph", () => {
  const root = mkdtempSync(join(tmpdir(), "probe-graph-"));
  const graph = buildGraph(root, scanOf(root), DEPS);

  test("direct dependents of a platform module are its impact at depth 1", () => {
    assert.deepEqual([...dependentAreas(graph, ":core:database", 1).keys()].sort(), ["chat", "profile"]);
  });

  test("depth 2 reaches the dependents' dependents, counting steps between areas", () => {
    const reach = dependentAreas(graph, ":core:network:api", 2);
    // core:network:impl depends on api but is the same area: it owns the change, not a dependent.
    assert.equal(reach.has("core:network"), false);
    assert.equal(reach.get("core:database"), 1);
    assert.equal(reach.get("chat"), 2);
    assert.equal(reach.get("profile"), 2);
    // app uses core:network:impl, which is the edited area, never a step away from it.
    assert.equal(reach.get("app"), undefined);
    assert.equal(dependentAreas(graph, ":core:network:api", 1).has("chat"), false);
  });

  test("usedBy and uses read both directions of an area", () => {
    assert.deepEqual(usedBy(graph, "core:database"), ["chat", "profile"]);
    assert.deepEqual(uses(graph, "core:database"), ["core:network"]);
    assert.deepEqual(uses(graph, "profile"), ["chat", "core:database"]);
  });
});

describe("stale marks", () => {
  test("a core edit marks the features depending on it stale, naming the area", () => {
    const project = fakeProject();
    const touched = featuresForFiles(project, ["core/database/src/main/Dao.kt"]);
    assert.equal(touched.get("core:database")?.owned, true);
    assert.deepEqual(touched.get("chat"), { files: ["core/database/src/main/Dao.kt"], owned: false, dependsOn: ["core:database"] });
    assert.equal(touched.get("profile")?.owned, false);
    assert.equal(touched.has("app"), false);
  });

  test("a feature edit stays its own: impact only spreads from platform code", () => {
    const project = fakeProject();
    const touched = featuresForFiles(project, ["feature/chat/api/src/main/Chat.kt"]);
    assert.deepEqual([...touched.keys()], ["chat"]);
  });

  test("impactDepth 0 turns the impact off, 2 reaches further", () => {
    assert.deepEqual([...featuresForFiles(fakeProject(0), ["core/database/Dao.kt"]).keys()], ["core:database"]);
    const far = featuresForFiles(fakeProject(2), ["core/network/api/Api.kt"]);
    assert.deepEqual([...far.keys()].sort(), ["chat", "core:database", "core:network", "profile"]);
  });

  test("markStale records dependsOn and the label says what the feature depends on", () => {
    const project = fakeProject();
    assert.deepEqual(markStale(project, [join(project.root, "core", "database", "Dao.kt")], "claude").sort(), ["chat", "core:database", "profile"]);
    const { stale } = loadWatch(project);
    assert.deepEqual(stale.chat?.dependsOn, ["core:database"]);
    assert.equal(staleLabel(stale.chat!), " (depends on core:database)");
    assert.equal(staleLabel(stale["core:database"]!), "");
    assert.equal(staleLabel({ owned: false }), " (related)");
  });

  test("a related path in a manifest still marks the feature stale without dependsOn", () => {
    const project = fakeProject();
    mkdirSync(join(project.root, "scripts"), { recursive: true });
    writeManifest(project, "chat", "id: chat\nsummary: x\nrelated:\n  - path: scripts/\n");
    assert.deepEqual(featuresForFiles(project, ["scripts/build.sh"]).get("chat"), { files: ["scripts/build.sh"], owned: false, dependsOn: [] });
  });
});

describe("init offers platform areas", () => {
  test("features come first, then platform areas with code; one with none is left out", () => {
    const project = fakeProject();
    const proposed = proposedAreas(project);
    assert.deepEqual(proposed.filter((a) => a.kind === "feature").map((a) => a.id).sort(), ["chat", "profile"]);
    assert.deepEqual(proposed.filter((a) => a.kind === "platform").map((a) => a.id).sort(), ["app", "core:database", "core:network"]);
    assert.equal(proposed.some((a) => a.id === "core:resources"), false);
  });

  test("a project whose features have manifests is offered its platform areas", () => {
    const project = fakeProject();
    writeManifest(project, "chat", "id: chat\nsummary: x\n");
    writeManifest(project, "profile", "id: profile\nsummary: x\n");
    assert.deepEqual(chosenFeatures(project)?.sort(), ["chat", "profile"]);
    assert.deepEqual(undecidedAreas(project).map((a) => a.id).sort(), ["app", "core:database", "core:network"]);
    const step = initStatus(project).find((s) => s.id === "features")!;
    assert.equal(step.status, "waiting");
    assert.match(step.detail, /3 more proposed \(0 features, 3 platform areas\): .*core:database/);
  });

  test("adding a platform area keeps the written features chosen", () => {
    const project = fakeProject();
    writeManifest(project, "chat", "id: chat\nsummary: x\n");
    chooseFeatures(project, ["core:database"], "add");
    assert.deepEqual(chosenFeatures(project)?.sort(), ["chat", "core:database"]);
    assert.deepEqual(undecidedAreas(project).map((a) => a.id).sort(), ["app", "core:network", "profile"]);
  });

  test("the word platform adds every proposed platform area", () => {
    const project = fakeProject();
    chooseFeatures(project, ["features"], "add");
    chooseFeatures(project, ["platform"], "add");
    assert.deepEqual(chosenFeatures(project)?.sort(), ["app", "chat", "core:database", "core:network", "profile"]);
    assert.equal(initStatus(project).find((s) => s.id === "features")!.status, "done");
  });

  test("a full choice declines what it leaves out, so it is not offered again", () => {
    const project = fakeProject();
    chooseFeatures(project, ["chat", "core:database"]);
    assert.deepEqual(undecidedAreas(project), []);
    assert.equal(initStatus(project).find((s) => s.id === "features")!.status, "done");
  });

  test("an unknown id is refused", () => {
    const project = fakeProject();
    assert.throws(() => chooseFeatures(project, ["core:nothing"], "add"), /Not features or platform areas of this project: core:nothing/);
  });
});
