import type { CardRun, Run } from "../core/types.js";
import { runningRuns } from "../engine/runs.js";
import type { VerifyOptions } from "../engine/verify.js";

/**
 * Long-running work Studio starts (drafting cards, unit runs, verify, init...), keyed by what
 * was asked for. The server is the record of what is going: a page opened mid-run asks here and
 * follows the run, and a second press of the same button attaches to the run instead of starting
 * a duplicate. Studio's page builds the same keys for its buttons, so keep the two in step.
 */
export const jobKeys = {
  unit: (feature: string) => `unit:${feature}`,
  backfill: (feature: string) => `backfill:${feature}`,
  ticketCards: (ticket: string) => `backfill:ticket:${ticket}`,
  explore: (feature: string) => `explore:${feature}`,
  unitwrite: (feature: string) => `unitwrite:${feature}`,
  card: (feature: string, cardId: string) => `card:${feature}/${cardId}`,
  login: (role?: string) => `login:${role || "check"}`,
  fix: (issueId: string) => `fix:${issueId}`,
  init: () => "init",
  check: () => "check",
  verify(o: VerifyOptions): string {
    if (o.outdated) return `verify:outdated${o.features?.length ? `:${[...o.features].sort().join(",")}` : ""}`;
    if (o.ticket) return `verify:ticket:${o.ticket}`;
    if (o.features?.length) return `verify:features:${[...o.features].sort().join(",")}`;
    return `verify:base:${o.base ?? ""}`;
  },
};

export interface Job {
  key: string;
  runId: string;
  kind: Run["kind"];
  feature: string;
  cardId?: string;
  startedAt: string;
  /** Started by another run (verify's unit and card runs); the page follows the parent. */
  child: boolean;
}

/** Keys of runs started through Studio, by run id. Dropped once the run is no longer running. */
const keys = new Map<string, string>();

/** A key for a run this registry did not start (from the MCP server or a parent run). */
function derivedKey(run: Run): string {
  if (run.kind === "card") return jobKeys.card(run.feature, (run as CardRun).cardId);
  if (run.kind === "init" || run.kind === "check") return run.kind;
  return `${run.kind}:${run.feature}`;
}

/** Every run of this process that is still going, with the key a Studio button knows it by. */
export function runningJobs(): Job[] {
  const running = runningRuns();
  const ids = new Set(running.map((r) => r.run.id));
  for (const id of keys.keys()) if (!ids.has(id)) keys.delete(id);
  return running.map(({ run, child }) => ({
    key: keys.get(run.id) ?? derivedKey(run),
    runId: run.id,
    kind: run.kind,
    feature: run.feature,
    cardId: run.kind === "card" ? (run as CardRun).cardId : undefined,
    startedAt: run.startedAt,
    child,
  }));
}

/** The running job with this key, if any. */
export function runningJob(key: string): Job | undefined {
  return runningJobs().find((j) => j.key === key && !j.child);
}

/**
 * Starts the work behind `key`, or hands back the run already doing it. `start` runs only when
 * nothing with that key is going; what it throws reaches the caller unchanged.
 */
export function startJob(key: string, start: () => { run: Run }): { runId: string; attached: boolean } {
  const busy = runningJob(key);
  if (busy) return { runId: busy.runId, attached: true };
  const { run } = start();
  keys.set(run.id, key);
  return { runId: run.id, attached: false };
}
