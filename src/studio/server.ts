import { spawnSync } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { listAccounts, removeAccount, saveAccount, Secrets } from "../accounts/accounts.js";
import { checkModel } from "../agent/headless.js";
import { loadConfig, localAgents, readLocalAgents, saveLocal } from "../core/config.js";
import { startBackfill } from "../cards/backfill.js";
import { lastLogin, startLoginRun } from "../accounts/login.js";
import { navMap, startExploreRun } from "../cards/explore.js";
import { startCardRun } from "../cards/run.js";
import { startUnitWrite } from "../engine/unitwrite.js";
import { startVerify, type VerifyOptions } from "../engine/verify.js";
import { fileTicket, ticketDraft, ticketInfo } from "../tickets/tickets.js";
import { setCardStatus } from "../cards/store.js";
import type { CardStatus, Run, SecurityRun } from "../core/types.js";
import { doctor } from "../engine/doctor.js";
import type { Project } from "../engine/project.js";
import { liveRun, stopRun, type RunEvent } from "../engine/runs.js";
import { startFix } from "../engine/fix.js";
import { openProject } from "../engine/project.js";
import { knownProjects } from "./projects.js";
import { dismissIssue, startSecurityRun } from "../security/run.js";
import { loadDismissals, undismiss } from "../security/findings.js";
import { RULES } from "../security/catalog/index.js";
import { findIssue, fixPrompt, issuesOf } from "../engine/issues.js";
import { unblockOf } from "../engine/unblock.js";
import { findFeature, latestScan, riskyGaps, scan } from "../engine/scan.js";
import { startUnitRun } from "../engine/unit.js";
import page from "./page.html";
import { startWatcher } from "../engine/watcher.js";
import { clearStudio, loadWatch, recordStudio, runningCheck, startCheck, type ChangeSource } from "../engine/watch.js";
import { approveDraft, draftDiffs, findDraft, listDrafts, rejectDraft } from "../knowledge/draft.js";
import { chooseFeatures, isInitStep, runningInit, startInit, type InitStepId } from "../engine/init.js";
import { jobKeys, runningJobs, startJob } from "./jobs.js";
import { cacheVersion, cachedAsync, gitStamp, invalidate, watchForChanges } from "./cache.js";
import { summary, type ViewName, type ViewValue } from "./views.js";
import { view } from "./viewWorker.js";
import { agentSettings, branchInfo, branchMismatch, projectSettings, saveProjectSettings, type ProjectSettingsBody } from "./project.js";
import { buildSettings, disconnectTracker, saveBuildSettings, saveTracker, testOptions, testTracker, trackerSettings, type BuildSettingsBody, type TrackerBody } from "./qa.js";
import { clearInbox, inboxList, inboxFetchedAt, inboxTicket, postResult, resultComment } from "../tickets/inbox.js";
import { openTracker } from "../tickets/tracker.js";
import { removeConnection, disconnect as disconnectConnection, saveAiAccount, removeAiAccount, saveAiUse, saveConnection, findConnection, trackerConnections, connectionMissing, hasConnectionToken, type ConnectionBody } from "../connections/connections.js";
import { openSlack, ticketDiscussion } from "../connections/slack.js";
import { inboxWarnings } from "../tickets/inbox.js";
import { startWork, ticketGroup } from "../tickets/workbench.js";
import { afterConnectionChange, connectionsView, myNames, saveWorkbench, setHidden, testConnection, workbenchView, type WorkbenchBody } from "./connections.js";
import { listBuilds } from "../devices/builds.js";
import type { BuildRef, BuildSource, RunTarget } from "../core/types.js";

let running: { server: Server; url: string } | null = null;
/** What the file watcher did lately, for Studio (Studio may run inside the MCP server, so never stdout). */
const watchLog: string[] = [];

/**
 * The project Studio shows. A person can switch it from the page; runs already going keep
 * their own project, and the file watcher and edit hooks follow the switch.
 */
interface Current {
  project: Project;
  stopWatcher?: () => void;
  stopCache?: () => void;
}

/** Starts Studio once per process and returns its URL; later calls reuse it. */
export async function startStudio(project: Project, preferredPort = 7777): Promise<string> {
  if (running) return running.url;
  // Studio's own git reads (status, diff) must not rewrite the index: that would look like a change.
  process.env.GIT_OPTIONAL_LOCKS ??= "0";
  for (let port = preferredPort; port < preferredPort + 20; port++) {
    const current: Current = { project };
    const server = createStudioServer(current);
    const ok = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => resolve(true));
    });
    if (ok) {
      running = { server, url: `http://localhost:${port}` };
      attach(current, project);
      return running.url;
    }
  }
  throw new Error(`No free port between ${preferredPort} and ${preferredPort + 19}`);
}

/** Points Studio at a project: its hooks send checks here, and its files are watched. */
function attach(current: Current, project: Project): void {
  current.stopWatcher?.();
  current.stopWatcher = undefined;
  current.stopCache?.();
  current.stopCache = watchForChanges(project);
  // The project left behind runs its edit checks in the background again, not in a Studio showing another project.
  if (current.project !== project) clearStudio(current.project);
  current.project = project;
  watchLog.length = 0;
  if (running) recordStudio(project, running.url);
  if (project.config.watch.enabled) current.stopWatcher = startWatcher(project, (line) => watchLog.push(`${new Date().toISOString().slice(11, 19)} ${line}`) > 50 && watchLog.shift());
}

/** Studio's HTTP server, not yet listening. A bare project (tests) is shown without switching. */
export function createStudioServer(target: Project | Current): Server {
  const current: Current = "store" in target ? { project: target } : target;
  return createServer((req, res) => {
    // Anything but a read may change what pages show: drop what was kept, before and after.
    const changes = req.method !== "GET" && req.method !== "HEAD";
    if (changes) invalidate();
    handle(current, req, res)
      .catch((e) => send(res, 500, { error: String(e) }))
      .finally(() => changes && invalidate());
  });
}

async function handle(current: Current, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";
  const project = current.project;

  // Any web page can send requests to localhost; only Studio's own page may change anything.
  const origin = req.headers.origin;
  if (method !== "GET" && origin && !/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) return send(res, 403, { error: "cross-origin request refused" });

  if (method === "GET" && path === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(page);
    return;
  }
  // Starting work: only on the branch the person is looking at (Studio sends it with every action).
  const isAction = method !== "GET" && !/^\/api\/(refresh|project|settings|accounts|tracker|connections|ai|workbench\/(settings|hide)|builds|cards\/[^/]+\/[^/]+\/status|runs\/[^/]+\/stop)/.test(path);
  const header = req.headers["x-probe-branch"];
  const mismatch = isAction ? branchMismatch(project, typeof header === "string" ? decodeURIComponent(header) : undefined) : null;
  if (mismatch) return send(res, 409, { error: mismatch, branchChanged: true });

  // Which project Studio shows, the others this machine knows, and switching between them.
  if (method === "GET" && path === "/api/projects") {
    const list = knownProjects();
    const here = { root: project.root, name: project.name, adapter: project.adapter.id };
    return send(res, 200, { current: here, projects: list.some((p) => p.root.toLowerCase() === project.root.toLowerCase()) ? list : [{ ...here, scannedAt: "" }, ...list] });
  }
  if (method === "POST" && path === "/api/projects/open") {
    const body = JSON.parse((await readBody(req)) || "{}") as { root?: string };
    if (!body.root?.trim()) return send(res, 400, { error: "Give the project folder." });
    let next: Project;
    try {
      next = openProject(body.root.trim());
    } catch (e) {
      return send(res, 400, { error: (e as Error).message });
    }
    if (next.root.toLowerCase() !== project.root.toLowerCase()) {
      if (!next.store.read("scan.json")) scan(next);
      attach(current, next);
    }
    return send(res, 200, { root: next.root, name: next.name });
  }

  // Switching branch changes the person's working tree, so it refuses when that could lose work or mix code into a run.
  if (method === "POST" && path === "/api/branch/switch") {
    const body = JSON.parse((await readBody(req)) || "{}") as { branch?: string };
    const want = body.branch?.trim();
    if (!want || want.startsWith("-")) return send(res, 400, { error: "Give a branch." });
    const info = branchInfo(project);
    if (!info.git) return send(res, 400, { error: "Not a git repository." });
    if (info.git.dirty) return send(res, 409, { error: `${info.git.dirty} uncommitted file(s): commit or stash them before switching.` });
    if (runningJobs().length) return send(res, 409, { error: "Runs are still going: stop them or wait before switching." });
    // A remote branch switches to its local tracking branch, which git creates when missing.
    const local = want.replace(/^origin\//, "");
    const out = spawnSync("git", ["switch", local], { cwd: project.root, encoding: "utf8" });
    if (out.status !== 0) return send(res, 400, { error: (out.stderr || out.stdout || "git switch failed").trim() });
    scan(project);
    return send(res, 200, branchInfo(project));
  }
  // Refresh: everything is read again, tickets included.
  if (method === "POST" && path === "/api/refresh") {
    clearInbox(project);
    return send(res, 200, { ok: true });
  }
  if (method === "GET" && path === "/api/branch") {
    const withBranches = url.searchParams.has("branches");
    return send(res, 200, await shown(project, `branch:${withBranches}:${gitStamp(project.root)}`, "branch", withBranches));
  }
  if (method === "GET" && path === "/api/setup") return send(res, 200, await shown(project, "setup", "setup"));
  if (method === "GET" && path === "/api/init") {
    const kept = await shown(project, "init", "init");
    return send(res, 200, { ...kept, running: runningInit() });
  }
  if (method === "POST" && path === "/api/init/run") {
    const body = JSON.parse((await readBody(req)) || "{}") as { step?: string; features?: string[]; accept?: boolean };
    if (body.step && !isInitStep(body.step)) return send(res, 400, { error: `Unknown step ${body.step}.` });
    try {
      const busy = runningInit();
      if (busy) return send(res, 200, { runId: busy, attached: true });
      return send(res, 200, startJob(jobKeys.init(), () => startInit(project, { step: body.step as InitStepId | undefined, features: body.features, accept: body.accept })));
    } catch (e) {
      return send(res, 409, { error: (e as Error).message });
    }
  }
  if (method === "POST" && path === "/api/init/features") {
    const body = JSON.parse((await readBody(req)) || "{}") as { features?: string[] };
    try {
      return send(res, 200, { chosen: chooseFeatures(project, body.features ?? []) });
    } catch (e) {
      return send(res, 400, { error: (e as Error).message });
    }
  }
  if (method === "GET" && path === "/api/project") return send(res, 200, projectSettings(project));
  if (method === "POST" && path === "/api/project") {
    const error = saveProjectSettings(project, JSON.parse(await readBody(req)) as ProjectSettingsBody);
    return error ? send(res, 400, { error }) : send(res, 200, projectSettings(project));
  }
  if (method === "GET" && path === "/api/scan") return send(res, 200, await shown(project, "scan", "scan"));
  if (method === "POST" && path === "/api/scan") return send(res, 200, summary(scan(project), project));
  if (method === "GET" && path === "/api/doctor") return send(res, 200, doctor(project));

  let m = /^\/api\/feature\/([^/]+)$/.exec(path);
  if (method === "GET" && m) {
    const feature = findFeature(latestScan(project), decodeURIComponent(m[1]!));
    if (!feature) return send(res, 404, { error: "unknown feature" });
    return send(res, 200, { ...feature, gaps: riskyGaps(feature, 50) });
  }

  m = /^\/api\/unit\/([^/]+)$/.exec(path);
  if (method === "POST" && m) {
    const feature = decodeURIComponent(m[1]!);
    return send(res, 200, startJob(jobKeys.unit(feature), () => startUnitRun(project, feature)));
  }

  if (method === "GET" && path === "/api/cards") {
    return send(res, 200, await shown(project, "cards", "cards"));
  }
  if (method === "GET" && path === "/api/navmap") return send(res, 200, navMap(project));

  // Keeping features current while people code: what is stale, the check, drafted corrections.
  if (method === "GET" && path === "/api/watch") {
    const state = loadWatch(project);
    return send(res, 200, {
      enabled: project.config.watch.enabled,
      stale: state.stale,
      running: runningCheck(project),
      checks: state.checks.slice(-30).reverse(),
      drafts: listDrafts(project).filter((d) => d.status === "pending").map(({ id, feature, createdAt, files }) => ({ id, feature, createdAt, files: files.map((f) => f.path) })),
      log: watchLog.slice(-20),
    });
  }
  if (method === "POST" && path === "/api/watch/check") {
    const body = JSON.parse(await readBody(req)) as { trigger?: ChangeSource; features?: string[]; drafts?: boolean };
    const here = runningJobs().find((j) => j.kind === "check");
    if (here) return send(res, 200, { runId: here.runId, attached: true });
    const started = startCheck(project, { trigger: body.trigger ?? "manual", features: body.features, drafts: body.drafts });
    return started ? send(res, 200, { runId: started.run.id, attached: false }) : send(res, 409, { error: `A check is already running (${runningCheck(project)?.runId}).` });
  }
  m = /^\/api\/knowledge\/([^/]+)$/.exec(path);
  if (method === "GET" && m) {
    const id = decodeURIComponent(m[1]!);
    return send(res, 200, await shown(project, `knowledge:${id}`, "knowledge", id));
  }
  m = /^\/api\/drafts\/([\w-]+)\/(approve|reject)$/.exec(path);
  if (method === "POST" && m) {
    const result = m[2] === "approve" ? approveDraft(project, m[1]!) : rejectDraft(project, m[1]!);
    return send(res, result.ok ? 200 : 409, result);
  }
  m = /^\/api\/drafts\/([\w-]+)$/.exec(path);
  if (method === "GET" && m) {
    const draft = findDraft(project, m[1]!);
    return draft ? send(res, 200, { ...draft, diffs: draftDiffs(project, draft) }) : send(res, 404, { error: "unknown draft" });
  }

  // What a verify would check right now, before anything runs.
  if (method === "GET" && path === "/api/changes") {
    const asked = url.searchParams.get("base");
    return send(res, 200, await shown(project, `changes:${asked ?? ""}:${gitStamp(project.root)}`, "changes", asked));
  }
  if (method === "POST" && path === "/api/verify") {
    const options = JSON.parse(await readBody(req)) as VerifyOptions;
    try {
      return send(res, 200, startJob(jobKeys.verify(options), () => startVerify(project, options)));
    } catch (e) {
      return send(res, 400, { error: (e as Error).message });
    }
  }

  m = /^\/api\/unitwrite\/([^/]+)$/.exec(path);
  if (method === "POST" && m) {
    const { limit } = JSON.parse(await readBody(req)) as { limit?: number };
    const feature = decodeURIComponent(m[1]!);
    return send(res, 200, startJob(jobKeys.unitwrite(feature), () => startUnitWrite(project, feature, { limit })));
  }

  m = /^\/api\/explore\/([^/]+)$/.exec(path);
  if (method === "POST" && m) {
    const feature = decodeURIComponent(m[1]!);
    return send(res, 200, startJob(jobKeys.explore(feature), () => startExploreRun(project, feature)));
  }

  if (method === "GET" && path === "/api/login") return send(res, 200, lastLogin(project));
  if (method === "POST" && path === "/api/login") {
    const { role } = JSON.parse(await readBody(req)) as { role?: string };
    return send(res, 200, startJob(jobKeys.login(role), () => startLoginRun(project, role || undefined)));
  }

  // Tickets: in (context, cards from a ticket) and out (draft, file).
  if (method === "GET" && path === "/api/tickets/config") {
    return send(res, 200, { canFile: !!project.config.tickets.fileCommand, pattern: project.config.tickets.pattern });
  }
  m = /^\/api\/tickets\/([^/]+)$/.exec(path);
  if (method === "GET" && m) return send(res, 200, ticketInfo(project, decodeURIComponent(m[1]!)));
  if (method === "POST" && path === "/api/tickets/cards") {
    const body = JSON.parse(await readBody(req)) as { ticket: string; text?: string; features?: string[] };
    const ticket = body.ticket?.trim();
    if (!ticket) return send(res, 400, { error: "Ticket id is required" });
    const features = body.features?.length ? body.features : ticketInfo(project, ticket).features;
    if (!features.length) return send(res, 400, { error: `No commits mention ${ticket}; choose the feature it belongs to.` });
    return send(res, 200, startJob(jobKeys.ticketCards(ticket), () => startBackfill(project, features, { ticket: { id: ticket, text: body.text?.trim() || undefined } })));
  }
  // The tracker connection (Jira, Linear). A token goes in and is sealed on this machine; it never comes back out.
  if (method === "GET" && path === "/api/tracker") return send(res, 200, trackerSettings(project));
  if (method === "POST" && path === "/api/tracker") {
    const error = saveTracker(project, JSON.parse(await readBody(req)) as TrackerBody);
    return error ? send(res, 400, { error }) : send(res, 200, trackerSettings(project));
  }
  if (method === "POST" && path === "/api/tracker/test") return send(res, 200, await testTracker(project));
  if (method === "DELETE" && path === "/api/tracker") {
    disconnectTracker(project);
    return send(res, 200, trackerSettings(project));
  }

  // Finished builds and the web app: what a test can run against besides the working tree.
  if (method === "GET" && path === "/api/builds/settings") return send(res, 200, buildSettings(project));
  if (method === "POST" && path === "/api/builds/settings") {
    const error = saveBuildSettings(project, JSON.parse(await readBody(req)) as BuildSettingsBody);
    return error ? send(res, 400, { error }) : send(res, 200, buildSettings(project));
  }
  if (method === "GET" && path === "/api/test-options") return send(res, 200, testOptions(project));
  if (method === "GET" && path === "/api/builds") {
    const source = url.searchParams.get("source") as BuildSource;
    if (source !== "firebase" && source !== "play") return send(res, 400, { error: "source: firebase or play" });
    try {
      return send(res, 200, await listBuilds(project, source));
    } catch (e) {
      return send(res, 400, { error: (e as Error).message });
    }
  }

  // The ticket inbox: the tracker's tickets waiting for a test, with what this repository knows about each.
  // Connections of the project Studio has open: trackers, Slack, the AI account. Tokens go in, never out.
  if (method === "GET" && path === "/api/connections") return send(res, 200, connectionsView(project));
  if (method === "POST" && path === "/api/connections") {
    const saved = saveConnection(project, JSON.parse(await readBody(req)) as ConnectionBody);
    afterConnectionChange(project);
    return "error" in saved ? send(res, 400, saved) : send(res, 200, { ...connectionsView(project), saved: saved.id });
  }
  m = /^\/api\/connections\/([\w-]+)(?:\/(test|channels|disconnect))?$/.exec(path);
  if (m) {
    const id = m[1]!;
    if (method === "POST" && m[2] === "test") return send(res, 200, await testConnection(project, id));
    if (method === "POST" && m[2] === "disconnect") {
      disconnectConnection(project, id);
      afterConnectionChange(project);
      return send(res, 200, connectionsView(project));
    }
    if (method === "GET" && m[2] === "channels") {
      const conn = findConnection(project, id);
      if (!conn || conn.kind !== "slack") return send(res, 404, { error: "No Slack connection with that id." });
      try {
        return send(res, 200, { channels: await openSlack(project, conn).channels() });
      } catch (e) {
        return send(res, 400, { error: (e as Error).message });
      }
    }
    if (method === "DELETE" && !m[2]) {
      removeConnection(project, id);
      afterConnectionChange(project);
      return send(res, 200, connectionsView(project));
    }
  }
  // The project's AI accounts on this machine, and which account and model each kind of work uses.
  if (method === "POST" && path === "/api/ai/accounts") {
    const saved = saveAiAccount(project, JSON.parse(await readBody(req)));
    return "error" in saved ? send(res, 400, saved) : send(res, 200, connectionsView(project));
  }
  m = /^\/api\/ai\/accounts\/([\w-]+)(\/test)?$/.exec(path);
  if (m && method === "DELETE") {
    removeAiAccount(project, m[1]!);
    return send(res, 200, connectionsView(project));
  }
  if (m && method === "POST" && m[2]) {
    const body = JSON.parse((await readBody(req)) || "{}") as { model?: string };
    return send(res, 200, await checkModel(project, body.model ?? project.config.agents.model, m[1]!));
  }
  if (method === "POST" && path === "/api/ai/use") {
    const error = saveAiUse(project, JSON.parse(await readBody(req)));
    return error ? send(res, 400, { error }) : send(res, 200, connectionsView(project));
  }

  // The workbench: how tickets are sorted and committed, and working through chosen tickets.
  if (method === "GET" && path === "/api/workbench/settings") return send(res, 200, workbenchView(project));
  if (method === "POST" && path === "/api/workbench/settings") {
    const error = saveWorkbench(project, JSON.parse(await readBody(req)) as WorkbenchBody);
    return error ? send(res, 400, { error }) : send(res, 200, workbenchView(project));
  }
  if (method === "POST" && path === "/api/workbench/hide") {
    const body = JSON.parse(await readBody(req)) as { key?: string; source?: string; hidden?: boolean };
    if (!body.key) return send(res, 400, { error: "key is required" });
    setHidden(project, body.key, body.source, body.hidden !== false);
    return send(res, 200, { ok: true });
  }
  if (method === "POST" && path === "/api/work") {
    const body = JSON.parse(await readBody(req)) as { tickets?: { key: string; source?: string; notes?: string }[]; steps?: string[]; commitPattern?: string; model?: string; account?: string; effort?: string; notes?: string; uiScope?: string };
    try {
      const tickets = (body.tickets ?? []).filter((t) => t && typeof t.key === "string");
      return send(res, 200, startJob(jobKeys.work(), () => startWork(project, { tickets, steps: body.steps ?? [], commitPattern: body.commitPattern, model: body.model?.trim() || undefined, account: body.account || undefined, effort: body.effort || undefined, notes: body.notes?.slice(0, 8000), uiScope: body.uiScope === "feature" ? "feature" : "ticket" })));
    } catch (e) {
      return send(res, 400, { error: (e as Error).message });
    }
  }
  m = /^\/api\/work\/([\w-]+)$/.exec(path);
  if (method === "GET" && m) {
    const run = liveRun(m[1]!)?.run ?? project.store.read<Run>(`runs/${m[1]}.json`);
    return run ? send(res, 200, run) : send(res, 404, { error: "unknown run" });
  }

  // The ticket inbox: every tracker of the project, with what this repository knows about each ticket.
  if (method === "GET" && path === "/api/inbox") {
    const conns = trackerConnections(project);
    const sources = conns.map((c) => ({ id: c.id, missing: connectionMissing(c, hasConnectionToken(project, c)) }));
    if (!sources.some((x) => !x.missing))
      return send(res, 200, { connected: false, missing: conns.length ? sources.map((x) => x.missing).filter(Boolean).join(" ") : "No ticket tracker connected to this project yet.", tickets: [], sources });
    try {
      // Matching each ticket to commits, runs and cards is kept too, until something changes.
      const refresh = url.searchParams.has("refresh");
      const list = await inboxList(project, { refresh });
      // A list read again from the trackers makes what was kept from the old one out of date.
      if (refresh) invalidate();
      const tickets = await shown(project, "", "inbox", list);
      const me = await myNames(project);
      const rules = project.config.workbench;
      return send(res, 200, { connected: true, sources, me, fetchedAt: inboxFetchedAt(project), warnings: inboxWarnings(project), tickets: tickets.map((t) => ({ ...t, ...ticketGroup(t, rules, me) })) });
    } catch (e) {
      return send(res, 200, { connected: true, sources, tickets: [], error: (e as Error).message });
    }
  }
  m = /^\/api\/inbox\/([^/]+)(?:\/(cards|test|comment|discussion))?$/.exec(path);
  if (m) {
    const id = decodeURIComponent(m[1]!);
    const source = url.searchParams.get("source") || undefined;
    try {
      if (method === "GET" && !m[2]) return send(res, 200, await inboxTicket(project, id, undefined, source));
      if (method === "GET" && m[2] === "discussion") {
        // The ticket as the list has it: no second trip to the tracker for its title and labels.
        const ticket = (await inboxList(project)).find((t) => t.id === id && (!source || t.source === source)) ?? (await inboxTicket(project, id, undefined, source));
        return send(res, 200, await ticketDiscussion(project, { id: ticket.id, title: ticket.title, labels: ticket.labels }));
      }
      // Cards from the ticket's own text, read from the tracker rather than pasted.
      if (method === "POST" && m[2] === "cards") {
        const body = JSON.parse(await readBody(req)) as { features?: string[] };
        const ticket = await inboxTicket(project, id, undefined, source);
        const features = body.features?.length ? body.features : ticket.features;
        if (!features.length) return send(res, 400, { error: `No commit names ${id} yet: choose the feature it belongs to.` });
        const text = `${ticket.title}\n\n${ticket.description}`.trim();
        return send(res, 200, startJob(jobKeys.ticketCards(id), () => startBackfill(project, features, { ticket: { id, text } })));
      }
      // A tester's check of the ticket: its cards (drafts too) on the working tree, a finished build or the web app.
      if (method === "POST" && m[2] === "test") {
        const body = JSON.parse(await readBody(req)) as { target?: RunTarget; build?: BuildRef; maxCards?: number };
        const options: VerifyOptions = { ticket: id, cards: "all", noUnit: true, target: body.target, build: body.build, maxCards: body.maxCards };
        return send(res, 200, startJob(jobKeys.verify(options), () => startVerify(project, options)));
      }
      // The comment a run would leave (GET), and leaving it (POST): only ever when a person presses Post.
      if (m[2] === "comment") {
        const runId = method === "GET" ? url.searchParams.get("run") : (JSON.parse(await readBody(req)) as { run?: string }).run;
        const run = runId && /^[\w-]+$/.test(runId) ? project.store.read<Run>(`runs/${runId}.json`) : null;
        if (!run) return send(res, 404, { error: "unknown run" });
        if (method === "GET") return send(res, 200, { body: resultComment(project, openTracker(project, undefined, source), run) });
        if (method === "POST") return send(res, 200, { posted: await postResult(project, id, run, undefined, source) });
      }
    } catch (e) {
      return send(res, 400, { error: (e as Error).message });
    }
  }

  m = /^\/api\/runs\/([^/]+)\/ticket(\/file)?$/.exec(path);
  if (m) {
    const run = project.store.read<Run>(`runs/${m[1]}.json`);
    if (!run) return send(res, 404, { error: "unknown run" });
    if (method === "GET" && !m[2]) return send(res, 200, ticketDraft(project, run));
    if (method === "POST" && m[2]) return send(res, 200, { output: fileTicket(project, run) });
  }

  m = /^\/api\/cards\/([^/]+)\/backfill$/.exec(path);
  if (method === "POST" && m) {
    const feature = decodeURIComponent(m[1]!);
    return send(res, 200, startJob(jobKeys.backfill(feature), () => startBackfill(project, feature)));
  }

  m = /^\/api\/cards\/([^/]+)\/([^/]+)\/run$/.exec(path);
  if (method === "POST" && m) {
    const [feature, cardId] = [decodeURIComponent(m[1]!), decodeURIComponent(m[2]!)];
    return send(res, 200, startJob(jobKeys.card(feature, cardId), () => startCardRun(project, feature, cardId)));
  }

  // Evidence files of a run: step screenshots and the screen recording.
  m = /^\/api\/runs\/([^/]+)\/files\/([\w.-]+\.(png|mp4|webm))$/.exec(path);
  if (method === "GET" && m) {
    const file = join(project.store.dir, "runs", m[1]!, m[2]!);
    if (!/^[\w-]+$/.test(m[1]!) || !existsSync(file)) return send(res, 404, { error: "no such file" });
    res.writeHead(200, { "content-type": m[3] === "png" ? "image/png" : `video/${m[3]}`, "cache-control": "max-age=3600" });
    createReadStream(file).pipe(res);
    return;
  }

  m = /^\/api\/cards\/([^/]+)\/([^/]+)\/status$/.exec(path);
  if (method === "POST" && m) {
    const { status } = JSON.parse(await readBody(req)) as { status: CardStatus };
    if (!["draft", "approved", "rejected"].includes(status)) return send(res, 400, { error: "bad status" });
    return send(res, 200, setCardStatus(project.root, decodeURIComponent(m[1]!), decodeURIComponent(m[2]!), status));
  }

  // Settings this machine owns (agent runner and model). Saved to local.yaml, applied at once.
  if (method === "GET" && path === "/api/settings") {
    return send(res, 200, { agents: agentSettings(project) });
  }
  if (method === "POST" && path === "/api/settings") {
    const body = JSON.parse(await readBody(req)) as { runner?: string | null; model?: string };
    const next = localAgents(readLocalAgents(project.store.dir), body);
    if (typeof next === "string") return send(res, 400, { error: next });
    saveLocal(project.store.dir, { agents: next });
    project.config = loadConfig(project.root, project.store.dir);
    return send(res, 200, { agents: agentSettings(project) });
  }
  if (method === "POST" && path === "/api/settings/test") {
    const { model } = JSON.parse(await readBody(req)) as { model?: string };
    return send(res, 200, await checkModel(project, model?.trim() || project.config.agents.model));
  }

  // Test accounts. A password or code goes in and is sealed on this machine; it never comes back out.
  if (method === "GET" && path === "/api/accounts") {
    const secrets = new Secrets(project.store.dir);
    return send(res, 200, listAccounts(project.root).map((a) => ({ ...a, hasPassword: secrets.has(a.role, "password"), hasCode: secrets.has(a.role, "code") })));
  }
  if (method === "POST" && path === "/api/accounts") {
    const body = JSON.parse(await readBody(req)) as { role?: string; username?: string; shownAs?: string; notes?: string; password?: string; code?: string };
    const role = body.role?.trim() ?? "";
    const username = body.username?.trim() ?? "";
    if (!/^[\w-]{1,40}$/.test(role)) return send(res, 400, { error: "Role: letters, digits, _ or -, e.g. user_a" });
    if (!username) return send(res, 400, { error: "Username is required" });
    saveAccount(project.root, { role, username, shownAs: body.shownAs?.trim() || undefined, notes: body.notes?.trim() || undefined });
    const secrets = new Secrets(project.store.dir);
    if (body.password) secrets.set(role, "password", body.password);
    if (body.code) secrets.set(role, "code", body.code);
    return send(res, 200, { ok: true });
  }
  m = /^\/api\/accounts\/([\w-]+)$/.exec(path);
  if (method === "DELETE" && m) {
    removeAccount(project.root, m[1]!);
    new Secrets(project.store.dir).remove(m[1]!);
    return send(res, 200, { ok: true });
  }

  // What is going right now, so a page opened mid-run can show it and follow it.
  if (method === "GET" && path === "/api/jobs") return send(res, 200, runningJobs());

  if (method === "GET" && path === "/api/runs") {
    // A run is saved when it ends, so the ones still going come from memory.
    const going = runningJobs().flatMap((j) => liveRun(j.runId)?.run ?? []).reverse();
    const ids = new Set(going.map((r) => r.id));
    const saved = project.store.listRuns<Run>().filter((r) => !ids.has(r.id));
    return send(res, 200, [...going, ...saved].map(runRow));
  }

  m = /^\/api\/runs\/([^/]+)$/.exec(path);
  if (method === "GET" && m) {
    const id = m[1]!;
    const active = liveRun(id);
    const stored = project.store.read<Run & { log: string[] }>(`runs/${id}.json`);
    if (active && active.run.status === "running") return send(res, 200, { ...active.run, log: active.log });
    return stored ? send(res, 200, stored) : send(res, 404, { error: "unknown run" });
  }

  // Problems of a run, and the two ways to fix one: a prompt to paste, or a fix agent.
  // A blocked run: why, what to do, and its blocked cards run again.
  m = /^\/api\/runs\/([\w-]+)\/unblock$/.exec(path);
  if (method === "GET" && m) {
    const run = project.store.read<Run>(`runs/${m[1]}.json`);
    if (!run) return send(res, 404, { error: "no such run" });
    const found = unblockOf(project, run);
    return send(res, 200, found ? { ...found, roles: listAccounts(project.root).map((a) => a.role) } : null);
  }
  m = /^\/api\/runs\/([\w-]+)\/again$/.exec(path);
  if (method === "POST" && m) {
    const run = project.store.read<Run>(`runs/${m[1]}.json`);
    const found = run && unblockOf(project, run);
    if (!run || !found) return send(res, 409, { error: "Nothing in this run was blocked." });
    const from = project.store.read<Run>(`runs/${found.runId}.json`);
    try {
      if (from?.kind === "card") {
        return send(res, 200, startJob(jobKeys.card(from.feature, from.cardId), () => startCardRun(project, from.feature, from.cardId, { target: from.target, build: from.build })));
      }
      const v = from?.kind === "verify" ? from : null;
      const options: VerifyOptions = { only: found.cards, noUnit: true, cards: "all", ticket: v?.ticket, target: v?.target, build: v?.build };
      return send(res, 200, startJob(jobKeys.verify(options), () => startVerify(project, options)));
    } catch (e) {
      return send(res, 409, { error: (e as Error).message });
    }
  }
  m = /^\/api\/runs\/([^/]+)\/issues$/.exec(path);
  if (method === "GET" && m) {
    const run = project.store.read<Run>(`runs/${m[1]}.json`);
    return run ? send(res, 200, issuesOf(project, run)) : send(res, 404, { error: "unknown run" });
  }
  // Security: the latest run (whole project first), starting one, and dismissals.
  if (method === "GET" && path === "/api/security") {
    const runs = project.store.listRuns<SecurityRun & { log?: string[] }>().filter((r) => r.kind === "security").map(({ log: _log, ...r }) => r);
    const latest = runs.find((r) => r.feature === "*") ?? runs[0] ?? null;
    return send(res, 200, { latest, recent: runs.slice(0, 10).map((r) => ({ id: r.id, feature: r.feature, status: r.status, startedAt: r.startedAt, open: r.findings.length })), dismissed: loadDismissals(project), rules: RULES.length, url: project.config.security.url ?? null });
  }
  if (method === "POST" && path === "/api/security") {
    const body = JSON.parse((await readBody(req)) || "{}") as { feature?: string; agent?: boolean; url?: string };
    try {
      return send(res, 200, startJob(jobKeys.security(body.feature), () => startSecurityRun(project, { feature: body.feature || undefined, agent: body.agent, url: body.url || undefined })));
    } catch (e) {
      return send(res, 400, { error: (e as Error).message });
    }
  }
  if (method === "POST" && path === "/api/security/undismiss") {
    const body = JSON.parse((await readBody(req)) || "{}") as { fingerprint?: string };
    return send(res, 200, { ok: undismiss(project, body.fingerprint ?? "") });
  }

  m = /^\/api\/issues\/([^/]+)\/dismiss$/.exec(path);
  if (method === "POST" && m) {
    const body = JSON.parse((await readBody(req)) || "{}") as { reason?: string };
    try {
      return send(res, 200, dismissIssue(project, decodeURIComponent(m[1]!), body.reason ?? ""));
    } catch (e) {
      return send(res, 400, { error: (e as Error).message });
    }
  }

  m = /^\/api\/issues\/([^/]+)\/(prompt|fix)$/.exec(path);
  if (m) {
    const id = decodeURIComponent(m[1]!);
    const found = findIssue(project, id);
    if (!found) return send(res, 404, { error: `unknown issue ${id}` });
    if (method === "GET" && m[2] === "prompt") return send(res, 200, { prompt: fixPrompt(project, found.issue, found.run, false) });
    if (method === "POST" && m[2] === "fix") {
      return send(res, 200, startJob(jobKeys.fix(id), () => startFix(project, id)));
    }
  }

  m = /^\/api\/runs\/([^/]+)\/stop$/.exec(path);
  if (method === "POST" && m) {
    if (stopRun(m[1]!)) return send(res, 200, { ok: true });
    const stored = project.store.read<Run>(`runs/${m[1]}.json`);
    return send(res, 409, { error: stored ? `Run ${m[1]} already finished (${stored.status}).` : `Run ${m[1]} is not running in this Studio. A run started from the CLI stops with Ctrl+C there.` });
  }

  m = /^\/api\/runs\/([^/]+)\/stream$/.exec(path);
  if (method === "GET" && m) return streamRun(project, m[1]!, res);

  send(res, 404, { error: "not found" });
}

/** Server-sent events: replays the log so far, then follows the run until it finishes. */
function streamRun(project: Project, id: string, res: ServerResponse): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const write = (e: RunEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  const active = liveRun(id);
  if (!active) {
    const stored = project.store.read<Run & { log?: string[] }>(`runs/${id}.json`);
    stored?.log?.forEach((line) => write({ type: "log", line }));
    if (stored) write({ type: "done", run: stored });
    res.end();
    return;
  }
  active.log.forEach((line) => write({ type: "log", line }));
  if (active.run.status !== "running") {
    write({ type: "done", run: active.run });
    res.end();
    return;
  }
  const listener = (e: RunEvent) => {
    write(e);
    if (e.type === "done") res.end();
  };
  active.events.on("event", listener);
  res.on("close", () => active.events.off("event", listener));
}

/** The Atlas list: features, stats and health, without per-class detail (that stays behind /api/feature). */
/** A run as the Runs list shows it: its row and filters, without its findings, steps and logs. */
function runRow(run: Run): Record<string, unknown> {
  const { log: _log, timeline, features, results, written, command: _command, skipped: _skipped, ...rest } = run as Run & Record<string, unknown> & {
    log?: unknown;
    timeline?: unknown[];
    features?: { feature: string; unitStatus?: string; draftId?: string; cards?: { runId?: string }[] }[];
    results?: { tests: number; failed: number }[];
    written?: unknown[];
  };
  const row: Record<string, unknown> = { ...rest };
  if (Array.isArray(row.findings)) row.findings = (row.findings as { severity?: string }[]).map((f) => ({ severity: f.severity }));
  for (const big of ["screens", "issues", "files", "drafts", "tickets"]) if (Array.isArray(row[big])) row[big] = new Array((row[big] as unknown[]).length).fill(0);
  if (timeline) row.timeline = new Array(timeline.length).fill(0);
  if (written) row.written = new Array(written.length).fill(0);
  if (results) row.results = results.map((x) => ({ tests: x.tests, failed: x.failed }));
  if (features) row.features = features.map((f) => ({ feature: f.feature, unitStatus: f.unitStatus, draftId: f.draftId, cards: (f.cards ?? []).filter((c) => c.runId).map(() => ({ runId: "1" })) }));
  return row;
}

/** A slow page's data: kept until something changes, worked out off Studio's thread. */
function shown<N extends ViewName>(project: Project, key: string, name: N, arg?: unknown): Promise<ViewValue<N>> {
  return cachedAsync(`${name}:${project.root}:${key}`, () => view(project, name, arg, cacheVersion()));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => resolve(body || "{}"));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
