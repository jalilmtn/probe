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
import { cardResults, featureHealth } from "../engine/health.js";
import { changedFiles, defaultBase } from "../engine/history.js";
import { startUnitWrite } from "../engine/unitwrite.js";
import { featuresOfFiles, startVerify, type VerifyOptions } from "../engine/verify.js";
import { fileTicket, ticketDraft, ticketInfo } from "../tickets/tickets.js";
import { listCards, setCardStatus } from "../cards/store.js";
import type { CardStatus, Run, ScanResult } from "../core/types.js";
import { doctor } from "../engine/doctor.js";
import type { Project } from "../engine/project.js";
import { liveRun, stopRun, type RunEvent } from "../engine/runs.js";
import { startFix } from "../engine/fix.js";
import { findIssue, fixPrompt, issuesOf } from "../engine/issues.js";
import { findFeature, latestScan, riskyGaps, scan } from "../engine/scan.js";
import { startUnitRun } from "../engine/unit.js";
import page from "./page.html";
import { startWatcher } from "../engine/watcher.js";
import { loadWatch, recordStudio, runningCheck, startCheck, type ChangeSource } from "../engine/watch.js";
import { approveDraft, draftDiffs, findDraft, listDrafts, rejectDraft } from "../knowledge/draft.js";
import { briefGlance, checkManifest, loadManifest, loadManifests, manifestFile } from "../knowledge/manifest.js";
import { describeCardProof, ruleProofs } from "../knowledge/proof.js";
import { chooseFeatures, chosenFeatures, initPendingDrafts, initStatus, isInitStep, proposedAreas, runningInit, startInit, undecidedAreas, type InitStepId } from "../engine/init.js";
import { areaGraph, usedBy, uses } from "../engine/impact.js";
import { jobKeys, runningJobs, startJob } from "./jobs.js";
import { agentSettings, branchInfo, branchMismatch, projectSettings, saveProjectSettings, setupChecklist, type ProjectSettingsBody } from "./project.js";

let running: { server: Server; url: string } | null = null;
/** What the file watcher did lately, for Studio (Studio may run inside the MCP server, so never stdout). */
const watchLog: string[] = [];

/** Starts Studio once per process and returns its URL; later calls reuse it. */
export async function startStudio(project: Project, preferredPort = 7777): Promise<string> {
  if (running) return running.url;
  for (let port = preferredPort; port < preferredPort + 20; port++) {
    const server = createStudioServer(project);
    const ok = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => resolve(true));
    });
    if (ok) {
      running = { server, url: `http://localhost:${port}` };
      recordStudio(project, running.url);
      if (project.config.watch.enabled) startWatcher(project, (line) => watchLog.push(`${new Date().toISOString().slice(11, 19)} ${line}`) > 50 && watchLog.shift());
      return running.url;
    }
  }
  throw new Error(`No free port between ${preferredPort} and ${preferredPort + 19}`);
}

/** Studio's HTTP server for a project, not yet listening. */
export function createStudioServer(project: Project): Server {
  return createServer((req, res) => handle(project, req, res).catch((e) => send(res, 500, { error: String(e) })));
}

async function handle(project: Project, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";

  // Any web page can send requests to localhost; only Studio's own page may change anything.
  const origin = req.headers.origin;
  if (method !== "GET" && origin && !/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) return send(res, 403, { error: "cross-origin request refused" });

  if (method === "GET" && path === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(page);
    return;
  }
  // Starting work: only on the branch the person is looking at (Studio sends it with every action).
  const isAction = method !== "GET" && !/^\/api\/(project|settings|accounts|cards\/[^/]+\/[^/]+\/status|runs\/[^/]+\/stop)/.test(path);
  const header = req.headers["x-probe-branch"];
  const mismatch = isAction ? branchMismatch(project, typeof header === "string" ? decodeURIComponent(header) : undefined) : null;
  if (mismatch) return send(res, 409, { error: mismatch, branchChanged: true });

  if (method === "GET" && path === "/api/branch") return send(res, 200, branchInfo(project, url.searchParams.has("branches")));
  if (method === "GET" && path === "/api/setup") return send(res, 200, setupChecklist(project));
  if (method === "GET" && path === "/api/init") {
    const scanned = project.store.read("scan.json") !== null;
    return send(res, 200, {
      steps: initStatus(project),
      // Each proposed feature or platform area, with whether it is chosen or not decided yet.
      proposed: scanned ? proposedAreaRows(project) : [],
      chosen: chosenFeatures(project),
      drafts: initPendingDrafts(project).map((d) => ({ ...d, diffs: draftDiffs(project, d) })),
      running: runningInit(),
    });
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
  if (method === "GET" && path === "/api/scan") return send(res, 200, summary(latestScan(project), project));
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
    const last = cardResults(project, latestScan(project));
    return send(res, 200, listCards(project.root).map((c) => ({ ...c, lastRun: last.get(`${c.feature}/${c.id}`) ?? null })));
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
    let manifest = null;
    try {
      manifest = loadManifest(project.root, id);
    } catch {
      // checkManifest below reports why it does not parse.
    }
    const exists = existsSync(join(project.root, manifestFile(id)));
    return send(res, 200, {
      file: manifestFile(id),
      manifest,
      check: exists ? checkManifest(project.root, id) : null,
      glance: manifest ? briefGlance(project.root, manifest) : null,
      // Each rule's cards with their last result, keyed by rule id.
      cards: manifest
        ? Object.fromEntries(
            ruleProofs(project, manifest).map((p) => [
              p.invariant.id,
              p.cards.map((c) => ({ ref: c.ref, feature: c.feature, id: c.id, title: c.card?.title, status: c.card?.status, result: c.result, freshness: c.freshness, text: describeCardProof(c) })),
            ]),
          )
        : {},
      stale: loadWatch(project).stale[id] ?? null,
      kind: manifest?.kind ?? findFeature(latestScan(project), id)?.group ?? "feature",
      ...areaLinks(project, id),
      drafts: listDrafts(project, id).filter((d) => d.status === "pending").map((d) => ({ ...d, diffs: draftDiffs(project, d) })),
    });
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
    const base = url.searchParams.get("base") || defaultBase(project.root, project.config.verify.base);
    if (!base) return send(res, 200, { base: null, files: [], features: [], unowned: [] });
    const files = changedFiles(project.root, base);
    const { byFeature, unowned } = featuresOfFiles(project, latestScan(project), files);
    return send(res, 200, { base, files, features: [...byFeature.entries()].map(([feature, fs]) => ({ feature, files: fs })), unowned });
  }
  if (method === "POST" && path === "/api/verify") {
    const options = JSON.parse(await readBody(req)) as VerifyOptions;
    return send(res, 200, startJob(jobKeys.verify(options), () => startVerify(project, options)));
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
  m = /^\/api\/runs\/([^/]+)\/files\/([\w.-]+\.(png|mp4))$/.exec(path);
  if (method === "GET" && m) {
    const file = join(project.store.dir, "runs", m[1]!, m[2]!);
    if (!/^[\w-]+$/.test(m[1]!) || !existsSync(file)) return send(res, 404, { error: "no such file" });
    res.writeHead(200, { "content-type": m[3] === "png" ? "image/png" : "video/mp4", "cache-control": "max-age=3600" });
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
    const saved = project.store.listRuns<Run & { log?: string[] }>().filter((r) => !ids.has(r.id)).map(({ log: _log, ...r }) => r);
    return send(res, 200, [...going, ...saved]);
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
  m = /^\/api\/runs\/([^/]+)\/issues$/.exec(path);
  if (method === "GET" && m) {
    const run = project.store.read<Run>(`runs/${m[1]}.json`);
    return run ? send(res, 200, issuesOf(project, run)) : send(res, 404, { error: "unknown run" });
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
function summary(result: ScanResult, project: Project) {
  const health = featureHealth(project, result);
  const manifests = new Map(loadManifests(project.root).map((m) => [m.id, m]));
  const graph = safeGraph(project, result);
  return {
    project: result.project,
    scannedAt: result.scannedAt,
    excluded: result.excluded,
    features: result.features.map((f) => {
      const h = health.get(f.id)!;
      const m = manifests.get(f.id);
      return {
        id: f.id,
        group: f.group,
        stats: f.stats,
        ...h,
        lastUnitRun: h.unit ? { ...h.unit, id: h.unit.runId, finishedAt: h.unit.at } : null,
        // Its written knowledge at a glance: rules, and how many nothing proves yet.
        manifest: m ? { kind: m.kind, rules: m.invariants.length, unproven: m.invariants.filter((i) => !i.coveredBy.length && !i.cards.length).length } : null,
        usedBy: graph ? usedBy(graph, f.id).length : 0,
      };
    }),
  };
}

/** The module graph, or none when the build files cannot be read: Studio still shows the rest. */
function safeGraph(project: Project, result: ScanResult) {
  try {
    return areaGraph(project, result);
  } catch {
    return null;
  }
}

/** Which areas an area uses and which use it, from the build files. */
function areaLinks(project: Project, id: string): { usedBy: string[]; uses: string[] } {
  const graph = safeGraph(project, latestScan(project));
  return graph ? { usedBy: usedBy(graph, id), uses: uses(graph, id) } : { usedBy: [], uses: [] };
}

/** Proposed areas for Setup's picker: chosen ones ticked, undecided ones marked new. */
function proposedAreaRows(project: Project) {
  const chosen = new Set(chosenFeatures(project) ?? []);
  const undecided = new Set(undecidedAreas(project).map((a) => a.id));
  const written = new Set(loadManifests(project.root).map((m) => m.id));
  return proposedAreas(project).map((a) => ({ ...a, chosen: chosen.has(a.id), undecided: undecided.has(a.id), manifest: written.has(a.id) }));
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
