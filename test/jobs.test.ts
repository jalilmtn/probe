import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { newRunId, Store } from "../src/core/store.js";
import type { Run, UnitRun } from "../src/core/types.js";
import type { Project } from "../src/engine/project.js";
import { launchRun, runningRuns } from "../src/engine/runs.js";
import { jobKeys, runningJob, runningJobs, startJob } from "../src/studio/jobs.js";
import { createStudioServer } from "../src/studio/server.js";

// The store lives under the home folder: point it at a scratch one.
const home = mkdtempSync(join(tmpdir(), "probe-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;

function fakeProject(): Project {
  const root = mkdtempSync(join(tmpdir(), "probe-project-"));
  return { root, name: "fake", adapter: {} as Project["adapter"], config: {} as Project["config"], store: new Store(root) };
}

function unitRun(feature: string): UnitRun {
  return { id: newRunId(), kind: "unit", feature, startedAt: new Date().toISOString(), status: "running", command: "", results: [] };
}

/** A run that keeps going until `finish` is called. */
function holdRun(project: Project, run: Run = unitRun("chat")) {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => (finish = resolve));
  const started = launchRun(project, run, async (log) => {
    log("working");
    await gate;
  });
  return { ...started, finish: async () => (finish(), await started.done) };
}

describe("runs registry", () => {
  test("a run is listed while it runs and not after", async () => {
    const project = fakeProject();
    const held = holdRun(project);
    assert.ok(runningRuns().some((r) => r.run.id === held.run.id));
    await held.finish();
    assert.ok(!runningRuns().some((r) => r.run.id === held.run.id));
    assert.equal(project.store.read<Run>(`runs/${held.run.id}.json`)?.status, "passed");
  });

  test("a run started by another run is marked as its child", async () => {
    const project = fakeProject();
    let child!: ReturnType<typeof holdRun>;
    let childStarted!: () => void;
    const ready = new Promise<void>((resolve) => (childStarted = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const parent = launchRun(project, unitRun("verify-parent"), async () => {
      child = holdRun(project, unitRun("verify-child"));
      childStarted();
      await gate;
    });
    await ready;
    const listed = runningRuns();
    assert.equal(listed.find((r) => r.run.id === parent.run.id)?.child, false);
    assert.equal(listed.find((r) => r.run.id === child.run.id)?.child, true);
    await child.finish();
    release();
    await parent.done;
  });
});

describe("jobs", () => {
  test("pressing the same button twice attaches to the run instead of starting another", async () => {
    const project = fakeProject();
    let starts = 0;
    let held!: ReturnType<typeof holdRun>;
    const start = () => {
      starts++;
      held = holdRun(project, unitRun("profile"));
      return held;
    };
    const first = startJob(jobKeys.unit("profile"), start);
    const second = startJob(jobKeys.unit("profile"), start);
    assert.equal(first.attached, false);
    assert.deepEqual(second, { runId: first.runId, attached: true });
    assert.equal(starts, 1);
    assert.equal(runningJob(jobKeys.unit("profile"))?.runId, first.runId);
    await held.finish();
    assert.equal(runningJob(jobKeys.unit("profile")), undefined);
    const again = startJob(jobKeys.unit("profile"), start);
    assert.equal(again.attached, false);
    assert.notEqual(again.runId, first.runId);
    assert.equal(starts, 2);
    await held.finish();
  });

  test("different work runs side by side", async () => {
    const project = fakeProject();
    const helds: ReturnType<typeof holdRun>[] = [];
    const a = startJob(jobKeys.backfill("chat"), () => (helds.push(holdRun(project, unitRun("chat"))), helds.at(-1)!));
    const b = startJob(jobKeys.backfill("comment"), () => (helds.push(holdRun(project, unitRun("comment"))), helds.at(-1)!));
    assert.notEqual(a.runId, b.runId);
    const keys = runningJobs().map((j) => j.key);
    assert.ok(keys.includes("backfill:chat") && keys.includes("backfill:comment"));
    for (const h of helds) await h.finish();
  });

  test("a run started outside Studio still gets a key its button knows", async () => {
    const project = fakeProject();
    const held = holdRun(project, unitRun("relations"));
    assert.equal(runningJobs().find((j) => j.runId === held.run.id)?.key, jobKeys.unit("relations"));
    await held.finish();
  });

  test("a start that throws starts nothing and reaches the caller", () => {
    assert.throws(() => startJob(jobKeys.explore("nope"), () => { throw new Error("Unknown feature"); }), /Unknown feature/);
    assert.equal(runningJob(jobKeys.explore("nope")), undefined);
  });

  test("verify keys do not depend on the order features were given in", () => {
    assert.equal(jobKeys.verify({ features: ["b", "a"] }), jobKeys.verify({ features: ["a", "b"] }));
    assert.equal(jobKeys.verify({ outdated: true }), "verify:outdated");
    assert.equal(jobKeys.verify({ outdated: true, features: ["chat"] }), "verify:outdated:chat");
    assert.notEqual(jobKeys.verify({ ticket: "VAN-1" }), jobKeys.verify({ base: "develop" }));
  });
});

describe("Studio /api/jobs", () => {
  const project = fakeProject();
  const server = createStudioServer(project);
  let base = "";
  before(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const get = async <T>(path: string) => (await fetch(base + path)).json() as Promise<T>;

  test("a page opened mid-run sees the job, follows it and then sees its result", async () => {
    let held!: ReturnType<typeof holdRun>;
    const { runId } = startJob(jobKeys.backfill("stream"), () => (held = holdRun(project, unitRun("stream"))));

    const jobs = await get<{ key: string; runId: string; child: boolean }[]>("/api/jobs");
    assert.deepEqual(jobs.filter((j) => j.runId === runId).map(({ key, child }) => ({ key, child })), [{ key: "backfill:stream", child: false }]);

    // The Runs list shows it before it is saved.
    const runs = await get<Run[]>("/api/runs");
    assert.equal(runs.find((r) => r.id === runId)?.status, "running");

    // Pressing Draft cards again attaches instead of starting a second agent.
    const again = await (await fetch(`${base}/api/cards/stream/backfill`, { method: "POST" })).json();
    assert.deepEqual(again, { runId, attached: true });

    // Following it streams the log so far, then its end.
    const stream = fetch(`${base}/api/runs/${runId}/stream`).then((r) => r.text());
    await new Promise((resolve) => setTimeout(resolve, 50));
    await held.finish();
    const events = (await stream).split("\n\n").filter(Boolean).map((e) => JSON.parse(e.replace(/^data: /, "")));
    assert.ok(events.some((e) => e.type === "log" && e.line === "working"));
    assert.equal(events.at(-1).type, "done");
    assert.equal(events.at(-1).run.status, "passed");

    assert.ok(!(await get<{ runId: string }[]>("/api/jobs")).some((j) => j.runId === runId));
    assert.equal((await get<Run>(`/api/runs/${runId}`)).status, "passed");
  });
});
