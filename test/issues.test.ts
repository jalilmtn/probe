import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { newRunId, Store } from "../src/core/store.js";
import type { CheckRun, UnitRun } from "../src/core/types.js";
import { buildFailure, issuesOf } from "../src/engine/issues.js";
import type { Project } from "../src/engine/project.js";

// The store lives under the home folder: point it at a scratch one.
const home = mkdtempSync(join(tmpdir(), "probe-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;

function fakeProject(): Project {
  const root = mkdtempSync(join(tmpdir(), "probe-project-"));
  return { root, name: "fake", adapter: {} as Project["adapter"], config: {} as Project["config"], store: new Store(root) };
}

const gradleSelectionFailure = [
  "FAILURE: Build failed with an exception.",
  "",
  "* What went wrong:",
  "Selection failed",
  "  Cannot locate tasks that match ':feature:explore:game:api:testDebugUnitTest' as task 'testDebugUnitTest' not found in project ':feature:explore:game:api'.",
  "",
  "* Try:",
  "> Run gradlew tasks to get a list of available tasks.",
];

describe("build failures", () => {
  test("Gradle's what-went-wrong block is the cause", () => {
    assert.equal(
      buildFailure(gradleSelectionFailure),
      "Selection failed\nCannot locate tasks that match ':feature:explore:game:api:testDebugUnitTest' as task 'testDebugUnitTest' not found in project ':feature:explore:game:api'.",
    );
  });

  test("compiler errors win over Gradle's summary", () => {
    const log = ["e: file:///a/AgoraRtcModule.kt:39:25 Unresolved reference 'AGORA_APP_ID_DEBUG_KEY'.", ...gradleSelectionFailure];
    assert.equal(buildFailure(log), "file:///a/AgoraRtcModule.kt:39:25 Unresolved reference 'AGORA_APP_ID_DEBUG_KEY'.");
  });

  test("a log that says neither has no cause", () => {
    assert.equal(buildFailure(["> Task :app:compileDebugKotlin", "BUILD FAILED"]), null);
  });
});

describe("issues of a check run", () => {
  test("lists the problems of the unit runs it started, under their own run ids", () => {
    const project = fakeProject();
    const unit: UnitRun & { log: string[] } = {
      id: newRunId(),
      kind: "unit",
      feature: "explore",
      startedAt: new Date().toISOString(),
      status: "error",
      command: "",
      results: [],
      error: "Build exited with code 1 (see log: compile error or missing task).",
      log: gradleSelectionFailure,
    };
    project.store.write(`runs/${unit.id}.json`, unit);
    const check: CheckRun = {
      id: `${unit.id}-check`,
      kind: "check",
      feature: "*",
      startedAt: new Date().toISOString(),
      status: "failed",
      trigger: "claude",
      features: [{ feature: "explore", files: [], owned: true, failures: [], unitRun: unit.id, unitStatus: "error" }],
      skipped: [],
      costUsd: 0,
    };

    const issues = issuesOf(project, check);

    assert.equal(issues.length, 1);
    assert.equal(issues[0]!.kind, "build");
    assert.equal(issues[0]!.runId, unit.id);
    assert.match(issues[0]!.title, /^Build failed: Selection failed/);
    assert.match(issues[0]!.detail, /testDebugUnitTest' not found/);
  });
});
