import { spawnSync } from "node:child_process";
import { listCards } from "../cards/store.js";
import type { CardRun, Run, VerifyRun } from "../core/types.js";
import type { Project } from "../engine/project.js";
import { ticketInfo } from "./tickets.js";
import { openTracker, type Fetch, type Tracker, type TrackerTicket } from "./tracker.js";

/**
 * Whether a build holds a ticket's work: `included` when every commit naming the ticket is in
 * the build's tag, `missing` when one is not, `unknown` when the build has no tag in this
 * repository or no commit names the ticket.
 */
export type BuildState = "included" | "missing" | "unknown";

/** A tracker ticket with what this repository knows about it. */
export interface InboxTicket extends TrackerTicket {
  commits: number;
  features: string[];
  cards: string[];
  buildState?: BuildState;
  /** The git tag the build was matched to. */
  buildTag?: string;
  /** The last Probe run for this ticket, newest first. */
  lastRun?: { id: string; status: string; at: string };
}

const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; tickets: InboxTicket[] }>();

/** The tracker's tickets waiting for a test, each with its commits, features, cards and build. */
export async function inbox(project: Project, options: { refresh?: boolean; fetcher?: Fetch } = {}): Promise<InboxTicket[]> {
  const key = project.root.toLowerCase();
  const hit = cache.get(key);
  if (hit && !options.refresh && Date.now() - hit.at < CACHE_MS) return hit.tickets;
  const tracker = openTracker(project, options.fetcher);
  const runs = ticketRuns(project);
  const tickets = (await tracker.list()).map((t) => enrich(project, t, runs));
  cache.set(key, { at: Date.now(), tickets });
  return tickets;
}

/** One ticket, read fresh from the tracker. */
export async function inboxTicket(project: Project, id: string, fetcher?: Fetch): Promise<InboxTicket> {
  return enrich(project, await openTracker(project, fetcher).get(id), ticketRuns(project));
}

/** Forgets the cached list, after the connection or filter changed. */
export function clearInbox(project: Project): void {
  cache.delete(project.root.toLowerCase());
}

function enrich(project: Project, ticket: TrackerTicket, runs: Map<string, InboxTicket["lastRun"]>): InboxTicket {
  const info = ticketInfo(project, ticket.id);
  const build = ticket.build ? buildState(project, ticket.build, info.commits.map((c) => c.hash)) : undefined;
  return { ...ticket, commits: info.commits.length, features: info.features, cards: info.cards, buildState: build?.state, buildTag: build?.tag, lastRun: runs.get(ticket.id) };
}

/** The newest verify run of each ticket. */
function ticketRuns(project: Project): Map<string, InboxTicket["lastRun"]> {
  const out = new Map<string, InboxTicket["lastRun"]>();
  for (const run of project.store.listRuns<Run>()) {
    if (run.kind !== "verify" || !run.ticket || out.has(run.ticket)) continue;
    out.set(run.ticket, { id: run.id, status: run.status, at: run.finishedAt ?? run.startedAt });
  }
  return out;
}

/** The tag a build number goes by: the configured pattern, else the usual spellings. */
export function buildTags(pattern: string | undefined, build: string): string[] {
  const names = pattern ? [pattern.replace(/\{build\}/g, build)] : [build, `v${build}`, `build-${build}`, `release-${build}`];
  return [...new Set(names)];
}

/** Whether the build's tag contains every one of `commits`. */
export function buildState(project: Project, build: string, commits: string[]): { state: BuildState; tag?: string } {
  // No shell: a build number comes from a ticket someone else wrote.
  const git = (...args: string[]) => spawnSync("git", args, { cwd: project.root, encoding: "utf8", windowsHide: true, timeout: 15_000 });
  const tag = buildTags(project.config.builds.tag, build).find((t) => /^[\w./+-]+$/.test(t) && git("rev-parse", "--verify", "--quiet", `refs/tags/${t}`).status === 0);
  if (!tag || commits.length === 0) return { state: "unknown", tag };
  const all = commits.every((hash) => git("merge-base", "--is-ancestor", hash, `refs/tags/${tag}`).status === 0);
  return { state: all ? "included" : "missing", tag };
}

/** What a run tested, in one line: the build, the device and the code. */
function testedLine(project: Project, run: VerifyRun | CardRun): string {
  const parts: string[] = [];
  if (run.build) parts.push(`Build: ${run.build.label}`);
  else if (run.target === "web") parts.push(`Web app${project.config.web?.url ? `: ${project.config.web.url}` : ""}`);
  else if (run.git) parts.push(`Code: ${run.git.branch ?? "detached"} @ ${run.git.commit}${run.git.dirty ? ` + ${run.git.dirty} uncommitted file(s)` : ""}`);
  if (run.kind === "card" && run.device) parts.push(`On: ${run.device}`);
  return parts.join(" · ");
}

/** The comment a run leaves on its ticket: the verdict, what was tested, each card's result. */
export function resultComment(project: Project, tracker: Pick<Tracker, "bold">, run: Run): string {
  if (run.kind !== "verify" && run.kind !== "card") throw new Error("Only a card run or a verify run can be posted to a ticket.");
  if (run.status === "running") throw new Error("The run is still going.");
  const titles = new Map(listCards(project.root).map((c) => [`${c.feature}/${c.id}`, c.title]));
  const lines = [tracker.bold(`Probe test: ${run.status.toUpperCase()}`), testedLine(project, run), ""];
  const cardLine = (feature: string, cardId: string, status: string, note?: string) =>
    `- ${status === "passed" ? "✓" : status === "skipped" ? "–" : status === "blocked" ? "?" : "✗"} ${titles.get(`${feature}/${cardId}`) ?? cardId} (${status})${note && status !== "passed" ? `: ${note.split("\n")[0]!.slice(0, 240)}` : ""}`;
  if (run.kind === "card") {
    lines.push(cardLine(run.feature, run.cardId, run.status, run.error ?? run.verdict?.notes));
    for (const e of run.verdict?.expectations ?? []) lines.push(`  - ${e.met === true ? "✓" : e.met === false ? "✗" : "?"} ${e.text}${e.met === true ? "" : ` — ${e.evidence}`}`);
    if (run.crashes.length) lines.push("", "The app crashed during the test.");
  } else {
    if (run.error) lines.push(run.error, "");
    for (const f of run.features) {
      if (f.unitStatus) lines.push(`- ${f.unitStatus === "passed" ? "✓" : "✗"} ${f.feature}: unit tests ${f.unitStatus}`);
      for (const c of f.cards) if (c.cardId !== "—") lines.push(cardLine(f.feature, c.cardId, c.status, c.note));
    }
  }
  lines.push("", `Probe run ${run.id}. Screenshots and video are on the tester's machine.`);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

/** Posts a run's result to its ticket as a comment. Only ever called when a person presses Post. */
export async function postResult(project: Project, ticketId: string, run: Run, fetcher?: Fetch): Promise<string> {
  const tracker = openTracker(project, fetcher);
  const body = resultComment(project, tracker, run);
  await tracker.comment(ticketId, body);
  return body;
}
