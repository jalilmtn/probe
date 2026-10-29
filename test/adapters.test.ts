import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { devicesUnsupported, ignoredPathPattern } from "../src/adapters/adapter.js";
import { androidGradleAdapter } from "../src/adapters/android-gradle/index.js";
import { configuredAreas, globRegex } from "../src/adapters/generic/areas.js";
import { genericAdapter } from "../src/adapters/generic/index.js";
import { fromOutput, runCommands } from "../src/adapters/generic/unit.js";
import { nodeAdapter } from "../src/adapters/node/index.js";
import { detectAdapter } from "../src/adapters/registry.js";
import { loadConfig, type ProbeConfig } from "../src/core/config.js";
import { isTestPath, testedName, testNamesIn } from "../src/core/testfiles.js";
import type { DeviceRun } from "../src/core/types.js";
import { runOnDevice } from "../src/devices/harness.js";
import { openProject } from "../src/engine/project.js";
import { scan } from "../src/engine/scan.js";

// The store lives under the home folder: point it at a scratch one.
const home = mkdtempSync(join(tmpdir(), "probe-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;

/** A project folder from a map of relative path to content; `.git` makes it a repository. */
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "probe-fixture-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

function config(root: string, patch: { unit?: Partial<ProbeConfig["unit"]> } = {}): ProbeConfig {
  const base = loadConfig(root, join(root, "no-local"));
  return { ...base, ...patch, unit: { ...base.unit, ...patch.unit } };
}

const REPO = {
  ".git/HEAD": "ref: refs/heads/main\n",
  "src/engine/run.ts": "export function run() {\n  return 1;\n}\n",
  "src/engine/util.ts": "export const x = 1;\n",
  "src/engine/run.test.ts": 'import { run } from "./run";\ntest("runs once", () => run());\n',
  "src/cli.ts": "console.log('cli');\n",
  "scripts/build.py": "print('build')\n",
  "test/util.test.ts": 'import { x } from "../src/engine/util.js";\nit("is one", () => x);\n',
  "docs/guide.md": "# Guide\n",
  "dist/bundle.js": "ignored build output\n",
};

describe("adapter registry", () => {
  test("Gradle settings win, then package.json, then any git repository", () => {
    assert.equal(detectAdapter(fixture({ "settings.gradle.kts": 'include(":app")\n', "package.json": "{}" }))?.id, "android-gradle");
    assert.equal(detectAdapter(fixture({ "package.json": "{}", ".git/HEAD": "" }))?.id, "node");
    assert.equal(detectAdapter(fixture({ ".git/HEAD": "" }))?.id, "generic");
    assert.equal(detectAdapter(fixture({ "probe/probe.yaml": "name: x\n" }))?.id, "generic");
    assert.equal(detectAdapter(fixture({ "readme.txt": "" })), null);
  });

  test("only the Android adapter runs apps on devices", () => {
    assert.equal(androidGradleAdapter.supportsDevices, true);
    assert.equal(genericAdapter.supportsDevices, false);
    assert.equal(nodeAdapter.supportsDevices, false);
  });

  test("each adapter ignores its own build folders", () => {
    const android = ignoredPathPattern(androidGradleAdapter);
    assert.ok(android.test("app/build/tmp/x.kt"));
    assert.ok(android.test(".gradle/caches/x"));
    assert.ok(android.test("feature/.kotlin/x"));
    assert.ok(android.test("node_modules/a/index.js"));
    assert.ok(!android.test("feature/chat/src/main/Chat.kt"));
    const node = ignoredPathPattern(nodeAdapter);
    assert.ok(node.test("dist/probe.cjs"));
    assert.ok(node.test("packages/a/coverage/lcov.info"));
    assert.ok(!node.test("src/engine/scan.ts"));
  });
});

describe("test file conventions", () => {
  test("names and folders mark test code", () => {
    for (const p of ["src/a.test.ts", "src/a.spec.js", "pkg/a_test.go", "test_a.py", "x/AppTest.kt", "test/helpers.ts", "tests/x.py", "a/__tests__/b.js", "app/src/test/kotlin/A.kt", "app/src/androidTest/B.kt"]) {
      assert.ok(isTestPath(p), p);
    }
    for (const p of ["src/contest.ts", "src/testing.ts", "src/latest/a.ts", "src/main/kotlin/Test.kt.bak"]) assert.ok(!isTestPath(p), p);
  });

  test("a test file is named after what it tests", () => {
    assert.equal(testedName("jobs.test.ts"), "jobs");
    assert.equal(testedName("store_test.go"), "store");
    assert.equal(testedName("test_parser.py"), "parser");
    assert.equal(testedName("ChatReducerTest.kt"), "ChatReducer");
  });

  test("test names come from each language's own style", () => {
    assert.deepEqual(testNamesIn('test("a run is listed", () => {});\nit(`works`, () => {});\ndescribe("x", () => {});'), ["a run is listed", "works"]);
    assert.deepEqual(testNamesIn("def test_parses_empty():\n    pass\n"), ["test_parses_empty"]);
    assert.deepEqual(testNamesIn("func TestStore(t *testing.T) {}"), ["TestStore"]);
  });
});

describe("generic adapter", () => {
  test("areas follow the folder layout and tests attach to what they import", () => {
    const root = fixture(REPO);
    const modules = genericAdapter.scanModules(root, config(root));
    const byId = new Map(modules.map((m) => [m.id, m]));
    assert.deepEqual([...byId.keys()].sort(), [":scripts", ":src", ":src:engine"]);
    const engine = byId.get(":src:engine")!;
    assert.deepEqual(engine.feature, { id: "engine", group: "feature" });
    assert.deepEqual(byId.get(":src")!.feature, { id: "src", group: "platform" });
    assert.equal(engine.testFiles, 2, "its own test and the one in test/ that imports it");
    assert.equal(engine.mainFiles, 2);
    assert.deepEqual(
      Object.fromEntries(engine.classes.map((c) => [c.name, c.test])),
      { run: "direct", util: "direct" },
    );
    assert.equal(byId.get(":src")!.classes[0]!.file, "src/cli.ts", "a container's own files stay with the container");
    assert.equal(engine.unitTestTask, null, "no command configured");
  });

  test("unit.command runs areas that have tests; unit.areas overrides one area", () => {
    const root = fixture(REPO);
    const modules = genericAdapter.scanModules(root, config(root, { unit: { command: "npm test", areas: { scripts: "pytest scripts" } } }));
    const task = Object.fromEntries(modules.map((m) => [m.id, m.unitTestTask]));
    assert.deepEqual(task, { ":src:engine": "npm test", ":src": null, ":scripts": "pytest scripts" });
  });

  test("probe.yaml areas: a map names them, a list makes each folder one", () => {
    const files = ["web/src/a.ts", "web/public/b.js", "web/src/deep/c.ts", "packages/x/index.ts", "packages/y/index.ts", "libs/x/index.ts"];
    assert.deepEqual(configuredAreas({ web: ["web/src", "web/public"] }, files), [{ id: "web", group: "feature", dirs: ["web/public", "web/src"] }]);
    assert.deepEqual(
      configuredAreas(["packages/*", "libs/*"], files).map((a) => [a.id, a.dirs]),
      [["libs/x", ["libs/x"]], ["packages/x", ["packages/x"]], ["y", ["packages/y"]]],
    );
    assert.ok(globRegex("src/**").test("src/a/b"));
    assert.ok(!globRegex("src/*").test("src/a/b"));
  });

  test("a scan groups modules by the area the adapter gave them", () => {
    const root = fixture(REPO);
    const project = openProject(root);
    assert.equal(project.adapter.id, "generic");
    const result = scan(project);
    assert.equal(result.project.devices, false);
    assert.deepEqual(result.features.map((f) => `${f.group}:${f.id}`), ["feature:engine", "platform:scripts", "platform:src"]);
  });

  test("device runs say clearly that they are not available", async () => {
    const root = fixture(REPO);
    const project = openProject(root);
    const run = { id: "r", kind: "card", feature: "engine", startedAt: "", status: "running", cardId: "c", device: "", crashes: [], timeline: [], costUsd: 0 } as DeviceRun;
    await assert.rejects(
      runOnDevice(project, run, { prompt: () => "", reportTools: [] }, () => {}),
      (e: Error) => e.message === devicesUnsupported(genericAdapter),
    );
    await assert.rejects(genericAdapter.installApp(root, "x", "y", () => {}), /not available/);
    assert.equal(genericAdapter.detectApp(root), null);
  });
});

describe("unit results without a build tool", () => {
  test("runner summaries are read from the output", () => {
    assert.deepEqual(pick(fromOutput("m", ["ℹ tests 8", "ℹ suites 3", "ℹ pass 7", "ℹ fail 1", "ℹ skipped 0", "ℹ todo 0", "✖ a run is listed (12ms)"])), { tests: 8, failed: 1, skipped: 0, failures: ["a run is listed"] });
    assert.deepEqual(pick(fromOutput("m", ["# tests 3", "# pass 3", "# fail 0"])), { tests: 3, failed: 0, skipped: 0, failures: [] });
    assert.deepEqual(pick(fromOutput("m", ["  ● Store › keeps writes", "Tests:       1 failed, 2 skipped, 10 passed, 13 total"])), { tests: 13, failed: 1, skipped: 2, failures: ["Store › keeps writes"] });
    assert.deepEqual(pick(fromOutput("m", ["\x1b[31m Tests \x1b[39m 2 failed | 12 passed (14)"]))?.tests, 14);
    assert.deepEqual(pick(fromOutput("m", ["FAILED tests/test_a.py::test_x - assert 1 == 2", "===== 1 failed, 10 passed, 1 skipped in 0.52s ====="])), { tests: 12, failed: 1, skipped: 1, failures: ["tests/test_a.py::test_x"] });
    assert.deepEqual(pick(fromOutput("m", ["test result: ok. 4 passed; 0 failed; 1 ignored; 0 measured", "test result: FAILED. 2 passed; 1 failed; 0 ignored; 0 measured"])), { tests: 8, failed: 1, skipped: 1, failures: ["1 failed"] });
    assert.equal(fromOutput("m", ["compiling…", "done"]), null);
  });

  test("a command with no summary is judged by its exit code; JUnit XML wins when configured", async () => {
    const root = fixture({
      "fail.js": "console.log('boom'); process.exit(3);",
      "junit.js": `require("fs").mkdirSync("reports", { recursive: true }); require("fs").writeFileSync("reports/junit.xml", '<testsuite><testcase classname="a" name="ok"/><testcase classname="a" name="bad"><failure message="nope"/></testcase></testsuite>');`,
    });
    const module = (id: string, task: string) => ({ id, dir: root, platform: "unknown" as const, mainFiles: 1, testFiles: 1, instrumentedTestFiles: 0, unitTestTask: task, classes: [] });
    const lines: string[] = [];

    const failed = await runCommands(root, [module(":a", "node fail.js"), module(":b", "node fail.js")], (l) => lines.push(l), config(root));
    assert.equal(failed.exitCode, 3);
    assert.equal(failed.results!.length, 1, "one command, run once for both modules");
    assert.equal(failed.results![0]!.module, "node fail.js");
    assert.equal(failed.results![0]!.failed, 1);
    assert.match(failed.results![0]!.failures[0]!.message ?? "", /boom/);

    const junit = await runCommands(root, [module(":a", "node junit.js")], () => {}, config(root, { unit: { junit: "reports" } }));
    assert.deepEqual(pick(junit.results![0]!), { tests: 2, failed: 1, skipped: 0, failures: ["bad"] });
    assert.equal(junit.results![0]!.module, ":a");
  });
});

describe("node adapter", () => {
  const WORKSPACES = {
    ".git/HEAD": "",
    "package.json": JSON.stringify({ name: "mono", workspaces: ["packages/*"] }),
    "packages/a/package.json": JSON.stringify({ name: "@x/a", scripts: { test: "node --test" } }),
    "packages/a/src/store.ts": "export const s = 1;\n",
    "packages/a/src/store.test.ts": 'import { s } from "./store";\ntest("s", () => s);\n',
    "packages/b/package.json": JSON.stringify({ name: "@x/b", dependencies: { "@x/a": "*" }, scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
    "packages/b/index.ts": "export {};\n",
  };

  test("workspaces are the areas, each tested through its own test script", () => {
    const root = fixture(WORKSPACES);
    const modules = nodeAdapter.scanModules(root, config(root));
    const byArea = Object.fromEntries(modules.map((m) => [m.feature!.id, m]));
    assert.deepEqual(Object.keys(byArea).sort(), ["a", "b"]);
    assert.equal(byArea.a!.unitTestTask, "npm test --workspace=packages/a");
    assert.equal(byArea.b!.unitTestTask, null, "npm init's placeholder script is no test suite");
    assert.equal(byArea.a!.testFiles, 1);
    assert.deepEqual(Object.fromEntries(nodeAdapter.moduleDependencies(root)), { ":packages:a": [], ":packages:b": [":packages:a"] });
    assert.equal(nodeAdapter.projectName(root), "mono");
  });

  test("without workspaces it splits by folder and runs the root test script", () => {
    const root = fixture({ ...REPO, "package.json": JSON.stringify({ name: "solo", scripts: { test: "node test.mjs" } }), "pnpm-lock.yaml": "" });
    const modules = nodeAdapter.scanModules(root, config(root));
    assert.equal(modules.find((m) => m.id === ":src:engine")!.unitTestTask, "pnpm test");
    assert.equal(modules.find((m) => m.id === ":scripts")!.unitTestTask, null);
  });
});

function pick(r: { tests: number; failed: number; skipped: number; failures: { name: string }[] } | null) {
  return r && { tests: r.tests, failed: r.failed, skipped: r.skipped, failures: r.failures.map((f) => f.name) };
}
