import { EventEmitter } from "node:events";
import { runSignal } from "../core/proc.js";
import type { Run } from "../core/types.js";
import { gitState } from "./history.js";
import type { Project } from "./project.js";

export type RunEvent = { type: "log"; line: string } | { type: "done"; run: Run };

interface LiveRun {
  run: Run;
  stop: AbortController;
  events: EventEmitter;
  log: string[];
  /** Started by another run (verify -> unit and card runs), not by a person. */
  child: boolean;
}

/** Runs of this process, so Studio can attach to one that is already going. */
const live = new Map<string, LiveRun>();

export function liveRun(id: string): LiveRun | undefined {
  return live.get(id);
}

/** Runs of this process that are still going, oldest first. */
export function runningRuns(): { run: Run; child: boolean }[] {
  return [...live.values()]
    .filter((e) => e.run.status === "running")
    .map(({ run, child }) => ({ run, child }))
    .sort((a, b) => a.run.startedAt.localeCompare(b.run.startedAt));
}

/** How long a finished run stays in memory; after that its saved record answers for it. */
const FINISHED_KEPT_MS = 10 * 60_000;

/**
 * Stops a running run of this process: its build or agent is killed and it ends as "stopped".
 * Runs it started (verify's card runs) stop with it. False when it is not running here.
 */
export function stopRun(id: string): boolean {
  const entry = live.get(id);
  if (!entry || entry.run.status !== "running") return false;
  entry.stop.abort();
  return true;
}

/**
 * Runs `work` as a tracked run: its log streams to listeners, a thrown error becomes
 * status "error", and the finished run is saved with the tail of its log. `work` sets the
 * final status; one it leaves "running" becomes "passed".
 */
export function launchRun<R extends Run>(
  project: Project,
  run: R,
  work: (log: (line: string) => void) => Promise<void>,
): { run: R; done: Promise<R> } {
  const git = gitState(project.root);
  if (git) run.git = { branch: git.branch, commit: git.commit, dirty: git.dirty };
  const stop = new AbortController();
  // A run started by another (verify -> card runs) stops when its parent does.
  const parent = runSignal.getStore();
  parent?.addEventListener("abort", () => stop.abort(), { once: true });
  const entry: LiveRun = { run, stop, events: new EventEmitter(), log: [], child: parent !== undefined };
  live.set(run.id, entry);
  const log = (line: string) => {
    entry.log.push(line);
    entry.events.emit("event", { type: "log", line } satisfies RunEvent);
  };

  const done = (async () => {
    if (run.git) log(`code: ${run.git.branch ?? "detached HEAD"} @ ${run.git.commit}${run.git.dirty ? ` + ${run.git.dirty} uncommitted file(s)` : ""}`);
    try {
      await runSignal.run(stop.signal, () => work(log));
      if (run.status === "running") run.status = "passed";
    } catch (e) {
      run.status = "error";
      run.error = (e as Error).message;
    }
    // Whatever the work made of a killed build or agent, a stopped run is just stopped.
    if (stop.signal.aborted) {
      run.status = "stopped";
      run.error = "Stopped before it finished.";
      log("stopped");
    } else if (run.status === "error") log(`error: ${run.error}`);
    run.finishedAt = new Date().toISOString();
    project.store.writeRun(run.id, { ...run, log: entry.log.slice(-400) });
    entry.events.emit("event", { type: "done", run } satisfies RunEvent);
    setTimeout(() => live.get(run.id) === entry && live.delete(run.id), FINISHED_KEPT_MS).unref();
    return run;
  })();

  return { run, done };
}
