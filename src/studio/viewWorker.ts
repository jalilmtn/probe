import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { openProject, type Project } from "../engine/project.js";
import { computeView, type ViewName, type ViewValue } from "./views.js";

/**
 * Studio's slower pages are worked out on one worker thread. Git, manifest checks and results
 * freshness run synchronously; on Studio's own thread they held up every request behind them,
 * and the whole page froze for seconds while a run edited files and each edit made Studio
 * work everything out again.
 */

/** The probe script to start the worker from; without one (tests) views are worked out in place. */
let entry: string | null = null;

/** Called by the CLI entry with its own file, so Studio can start this script again as its worker. */
export function useViewWorker(file: string | undefined): void {
  entry = file ?? null;
}

/** True in the worker thread this module starts. */
export function isViewWorker(): boolean {
  return !isMainThread && (workerData as { probeViews?: boolean } | null)?.probeViews === true;
}

interface Ask {
  id: number;
  root: string;
  version: number;
  name: ViewName;
  arg: unknown;
}
type Answer = { id: number; value: unknown } | { id: number; error: string };

/** The worker's side: answers each question about the project, opened again once anything changed. */
export function runViewWorker(): void {
  let project: Project | null = null;
  let openedAt = -1;
  parentPort!.on("message", (ask: Ask) => {
    let answer: Answer;
    try {
      // Settings may have changed with what made Studio drop its cache: read them again.
      if (!project || project.root !== ask.root || openedAt !== ask.version) {
        project = openProject(ask.root);
        openedAt = ask.version;
      }
      answer = { id: ask.id, value: computeView(project, ask.name, ask.arg as never) };
    } catch (e) {
      answer = { id: ask.id, error: (e as Error).message };
    }
    parentPort!.postMessage(answer);
  });
}

let worker: Worker | null = null;
let nextId = 1;
const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function startWorker(file: string): Worker {
  const w = new Worker(file, { workerData: { probeViews: true } });
  w.unref();
  w.on("message", (a: Answer) => {
    const wait = waiting.get(a.id);
    if (!wait) return;
    waiting.delete(a.id);
    if ("error" in a) wait.reject(new Error(a.error));
    else wait.resolve(a.value);
  });
  const fail = (e: Error) => {
    if (worker === w) worker = null;
    for (const wait of waiting.values()) wait.reject(e);
    waiting.clear();
  };
  w.on("error", fail);
  w.on("exit", (code) => fail(new Error(`Studio's worker stopped (${code}).`)));
  return w;
}

/** A view of `project`, worked out off Studio's thread when it can be. */
export function view<N extends ViewName>(project: Project, name: N, arg: unknown, version: number): Promise<ViewValue<N>> {
  if (!entry) return Promise.resolve().then(() => computeView(project, name, arg as never));
  worker ??= startWorker(entry);
  const id = nextId++;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve: resolve as (v: unknown) => void, reject });
    worker!.postMessage({ id, root: project.root, version, name, arg } satisfies Ask);
  });
}

/** Stops the worker (Studio closing). */
export function stopViewWorker(): void {
  void worker?.terminate();
  worker = null;
}
