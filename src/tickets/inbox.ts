import { spawnSync } from "node:child_process";
import { listCards } from "../cards/store.js";
import type { CardRun, Run, VerifyRun } from "../core/types.js";
import type { Project } from "../engine/project.js";
import { latestScan } from "../engine/scan.js";
import { featuresOfFiles } from "../engine/verify.js";
import { connectionLabel, trackerConnections } from "../connections/connections.js";
import { openTracker, openTrackerFor, type Fetch, type Tracker, type TrackerTicket } from "./tracker.js";

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

/** The trackers' tickets as last read, kept on this machine until Refresh or a connection change. */
type KeptTicket = TrackerTicket & { source?: string; sourceLabel?: string };

interface KeptInbox {
  at: string;
  tickets: KeptTicket[];
  errors: string[];
}

const INBOX_FILE = "inbox.json";
const kept = new Map<string, KeptInbox>();
const reading = new Map<string, Promise<KeptInbox>>();

function keptInbox(project: Project): KeptInbox | null {
  const key = project.root.toLowerCase();
  let hit = kept.get(key) ?? null;
  if (!hit) {
    hit = project.store.read<KeptInbox>(INBOX_FILE);
    if (hit) kept.set(key, hit);
  }
  return hit;
}

/** Reads every tracker of the project, side by side; one that fails does not hide the others. */
async function readTrackers(project: Project, fetcher?: Fetch): Promise<KeptInbox> {
  const conns = trackerConnections(project);
  if (!conns.length) openTracker(project, fetcher); // throws what is missing
  const errors: string[] = [];
  const lists = await Promise.all(
    conns.map(async (conn) => {
      try {
        const tracker = openTrackerFor(project, conn, fetcher);
        return (await tracker.list()).map((t) => ({ ...t, source: conn.id, sourceLabel: connectionLabel(conn) }));
      } catch (e) {
        errors.push((e as Error).message);
        return [];
      }
    }),
  );
  if (errors.length && errors.length === conns.length) throw new Error(errors.join(" "));
  return { at: new Date().toISOString(), tickets: lists.flat(), errors };
}

/**
 * The tracker's tickets waiting for a test, each with its commits, features, cards and build.
 * The tracker is asked only the first time and on `refresh`: the list is kept on this machine,
 * and what Probe knows about each ticket (runs, cards, commits) is worked out fresh each time.
 */
export async function inbox(project: Project, options: { refresh?: boolean; fetcher?: Fetch } = {}): Promise<InboxTicket[]> {
  return enrichAll(project, await inboxList(project, options));
}

/** The tracker's tickets as kept on this machine, read from the trackers the first time and on `refresh`. */
export async function inboxList(project: Project, options: { refresh?: boolean; fetcher?: Fetch } = {}): Promise<KeptTicket[]> {
  const key = project.root.toLowerCase();
  let list = options.refresh ? null : keptInbox(project);
  if (!list) {
    let pending = reading.get(key);
    if (!pending) {
      pending = readTrackers(project, options.fetcher).finally(() => reading.delete(key));
      reading.set(key, pending);
    }
    list = await pending;
    kept.set(key, list);
    project.store.write(INBOX_FILE, list);
  }
  return list.tickets;
}

/** Each ticket with its commits, features, cards, build and last run. Runs git: Studio calls it on its worker. */
export function enrichAll(project: Project, tickets: KeptTicket[]): InboxTicket[] {
  // One read of the history, the scan and the cards for the whole list, not one per ticket.
  const runs = ticketRuns(project);
  const repo = repoIndex(project);
  return tickets.map((t) => enrich(project, t, runs, repo));
}

/** When the kept list was read from the trackers, if it has been. */
export function inboxFetchedAt(project: Project): string | null {
  return keptInbox(project)?.at ?? null;
}

/** Trackers that could not be read on the last load, while others could. */
export function inboxWarnings(project: Project): string[] {
  return keptInbox(project)?.errors ?? [];
}

/** One ticket, read fresh from the tracker it came from. */
export async function inboxTicket(project: Project, id: string, fetcher?: Fetch, source?: string): Promise<InboxTicket> {
  const conn = source ? trackerConnections(project).find((c) => c.id === source) : trackerConnections(project)[0];
  const ticket = await openTracker(project, fetcher, source).get(id);
  return enrich(project, { ...ticket, source: conn?.id, sourceLabel: conn ? connectionLabel(conn) : undefined }, ticketRuns(project), repoIndex(project));
}

/** Forgets the kept list, after the connection or filter changed or on Refresh. */
export function clearInbox(project: Project): void {
  kept.delete(project.root.toLowerCase());
  if (project.store.read(INBOX_FILE) !== null) project.store.write(INBOX_FILE, null);
}

interface RepoCommit {
  hash: string;
  text: string;
  files: string[];
}

/** What the repository knows, read once: recent commits with their files, the scan, the cards. */
interface RepoIndex {
  commits: RepoCommit[];
  scan: ReturnType<typeof latestScan>;
  cards: ReturnType<typeof listCards>;
}

const HISTORY = 3000;
const repoCache = new Map<string, { head: string; index: RepoIndex }>();

export function repoIndex(project: Project): RepoIndex {
  const git = (...args: string[]) => spawnSync("git", args, { cwd: project.root, encoding: "utf8", windowsHide: true, timeout: 60_000, maxBuffer: 256 * 1024 * 1024 });
  const head = git("rev-parse", "HEAD").stdout?.trim() ?? "";
  const key = project.root.toLowerCase();
  const hit = repoCache.get(key);
  const scan = latestScan(project);
  const cards = listCards(project.root);
  if (hit && hit.head === head && head) return { ...hit.index, scan, cards };
  const out = git("log", "--no-merges", `-n${HISTORY}`, "--name-only", "--format=%x1e%h%x1f%s%n%b%x1f").stdout ?? "";
  const commits: RepoCommit[] = [];
  for (const chunk of out.split("\x1e")) {
    const [hash, text, rest] = chunk.split("\x1f");
    if (!hash?.trim()) continue;
    commits.push({ hash: hash.trim(), text: text ?? "", files: (rest ?? "").split("\n").map((f) => f.trim()).filter(Boolean) });
  }
  const index = { commits, scan, cards };
  repoCache.set(key, { head, index });
  return index;
}

function enrich(project: Project, ticket: TrackerTicket, runs: Map<string, InboxTicket["lastRun"]>, repo: RepoIndex): InboxTicket {
  const id = ticket.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const named = new RegExp(`(^|[^A-Za-z0-9])${id}(?![0-9])`, "i");
  const commits = repo.commits.filter((c) => named.test(c.text)).slice(0, 50);
  const files = [...new Set(commits.flatMap((c) => c.files))];
  const features = files.length ? [...featuresOfFiles(project, repo.scan, files).byFeature.keys()] : [];
  const cards = repo.cards.filter((c) => c.tickets.includes(ticket.id)).map((c) => `${c.feature}/${c.id}`);
  const build = ticket.build ? buildState(project, ticket.build, commits.map((c) => c.hash)) : undefined;
  return { ...ticket, commits: commits.length, features, cards, buildState: build?.state, buildTag: build?.tag, lastRun: runs.get(ticket.id) };
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

const ancestors = new Map<string, boolean>();

/** Whether the build's tag contains every one of `commits`. */
export function buildState(project: Project, build: string, commits: string[]): { state: BuildState; tag?: string } {
  // No shell: a build number comes from a ticket someone else wrote.
  const git = (...args: string[]) => spawnSync("git", args, { cwd: project.root, encoding: "utf8", windowsHide: true, timeout: 15_000 });
  let target = "";
  const tag = buildTags(project.config.builds.tag, build).find((t) => {
    if (!/^[\w./+-]+$/.test(t)) return false;
    const r = git("rev-parse", "--verify", "--quiet", `refs/tags/${t}^{commit}`);
    target = r.stdout?.trim() ?? "";
    return r.status === 0;
  });
  if (!tag || commits.length === 0) return { state: "unknown", tag };
  // Whether a commit is in another never changes: each answer is asked once.
  const all = commits.every((hash) => {
    const key = `${project.root}|${hash}|${target}`;
    let yes = ancestors.get(key);
    if (yes === undefined) ancestors.set(key, (yes = git("merge-base", "--is-ancestor", hash, target || `refs/tags/${tag}`).status === 0));
    return yes;
  });
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
export async function postResult(project: Project, ticketId: string, run: Run, fetcher?: Fetch, source?: string): Promise<string> {
  const tracker = openTracker(project, fetcher, source);
  const body = resultComment(project, tracker, run);
  await tracker.comment(ticketId, body);
  return body;
}
