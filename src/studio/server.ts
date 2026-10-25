import { createReadStream, existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { listAccounts, removeAccount, saveAccount, Secrets } from "../accounts/accounts.js";
import { checkModel } from "../agent/headless.js";
import { agentModelSource, loadConfig, saveLocal } from "../core/config.js";
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
import { branchInfo, branchMismatch, projectSettings, saveProjectSettings, setupChecklist, type ProjectSettingsBody } from "./project.js";

let running: { server: Server; url: string } | null = null;

/** Starts Studio once per process and returns its URL; later calls reuse it. */
export async function startStudio(project: Project, preferredPort = 7777): Promise<string> {
  if (running) return running.url;
  for (let port = preferredPort; port < preferredPort + 20; port++) {
    const server = createServer((req, res) => handle(project, req, res).catch((e) => send(res, 500, { error: String(e) })));
    const ok = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => resolve(true));
    });
    if (ok) {
      running = { server, url: `http://localhost:${port}` };
      return running.url;
    }
  }
  throw new Error(`No free port between ${preferredPort} and ${preferredPort + 19}`);
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
    const { run } = startUnitRun(project, decodeURIComponent(m[1]!));
    return send(res, 200, { runId: run.id });
  }

  if (method === "GET" && path === "/api/cards") {
    const last = cardResults(project, latestScan(project));
    return send(res, 200, listCards(project.root).map((c) => ({ ...c, lastRun: last.get(`${c.feature}/${c.id}`) ?? null })));
  }
  if (method === "GET" && path === "/api/navmap") return send(res, 200, navMap(project));

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
    const { run } = startVerify(project, options);
    return send(res, 200, { runId: run.id });
  }

  m = /^\/api\/unitwrite\/([^/]+)$/.exec(path);
  if (method === "POST" && m) {
    const { limit } = JSON.parse(await readBody(req)) as { limit?: number };
    const { run } = startUnitWrite(project, decodeURIComponent(m[1]!), { limit });
    return send(res, 200, { runId: run.id });
  }

  m = /^\/api\/explore\/([^/]+)$/.exec(path);
  if (method === "POST" && m) {
    const { run } = startExploreRun(project, decodeURIComponent(m[1]!));
    return send(res, 200, { runId: run.id });
  }

  if (method === "GET" && path === "/api/login") return send(res, 200, lastLogin(project));
  if (method === "POST" && path === "/api/login") {
    const { role } = JSON.parse(await readBody(req)) as { role?: string };
    const { run } = startLoginRun(project, role || undefined);
    return send(res, 200, { runId: run.id });
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
    const { run } = startBackfill(project, features, { ticket: { id: ticket, text: body.text?.trim() || undefined } });
    return send(res, 200, { runId: run.id });
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
    const { run } = startBackfill(project, decodeURIComponent(m[1]!));
    return send(res, 200, { runId: run.id });
  }

  m = /^\/api\/cards\/([^/]+)\/([^/]+)\/run$/.exec(path);
  if (method === "POST" && m) {
    const { run } = startCardRun(project, decodeURIComponent(m[1]!), decodeURIComponent(m[2]!));
    return send(res, 200, { runId: run.id });
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

  // Settings this machine owns (agent model). Saved to local.yaml, applied at once.
  if (method === "GET" && path === "/api/settings") {
    return send(res, 200, { agents: { model: project.config.agents.model, source: agentModelSource(project.root, project.store.dir) } });
  }
  if (method === "POST" && path === "/api/settings") {
    const { model } = JSON.parse(await readBody(req)) as { model?: string };
    const value = model?.trim() ?? "";
    if (value && !/^[\w.[\]:-]{2,80}$/.test(value)) return send(res, 400, { error: "Model: a name claude --model accepts, e.g. sonnet" });
    saveLocal(project.store.dir, { agents: value ? { model: value } : undefined });
    project.config = loadConfig(project.root, project.store.dir);
    return send(res, 200, { agents: { model: project.config.agents.model, source: agentModelSource(project.root, project.store.dir) } });
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

  if (method === "GET" && path === "/api/runs") {
    return send(res, 200, project.store.listRuns<Run & { log?: string[] }>().map(({ log: _log, ...r }) => r));
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
      const { run } = startFix(project, id);
      return send(res, 200, { runId: run.id });
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
  return {
    project: result.project,
    scannedAt: result.scannedAt,
    excluded: result.excluded,
    features: result.features.map((f) => {
      const h = health.get(f.id)!;
      return { id: f.id, group: f.group, stats: f.stats, ...h, lastUnitRun: h.unit ? { ...h.unit, id: h.unit.runId, finishedAt: h.unit.at } : null };
    }),
  };
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
