import { Secrets } from "../accounts/accounts.js";
import {
  loadConfig,
  readLocalSettings,
  saveConnections,
  saveLocal,
  saveProject,
  AI_ROLES,
  EFFORTS,
  type AiAccount,
  type AiRole,
  type AiSettings,
  type Connection,
  type ConnectionKind,
  type ProbeConfig,
  type SlackChannel,
} from "../core/config.js";
import type { Project } from "../engine/project.js";

// A project's connections: the tools Probe and its agents use for this project only. What the team
// shares (which Jira, which Slack channels) is in probe/probe.yaml; each person's tokens are sealed
// in this project's own store on their machine, so two projects never share an account.

export const KIND_LABEL: Record<ConnectionKind | "ai", string> = { jira: "Jira", linear: "Linear", slack: "Slack", ai: "AI account" };

/** Which group a connection shows in. */
export function groupOf(kind: ConnectionKind): "tickets" | "conversations" {
  return kind === "slack" ? "conversations" : "tickets";
}

/** The old single tracker (`tickets.tracker`), shown as a connection until it is replaced. */
function legacyTracker(config: ProbeConfig): Connection | null {
  const t = config.tickets;
  if (!t.tracker) return null;
  return { id: "tracker", kind: t.tracker, site: t.site, filter: t.filter, team: t.team, buildField: t.buildField, email: t.email, legacy: true };
}

/** Every connection of the project: the shared list, plus the old single tracker if it is still set. */
export function connections(project: { config: ProbeConfig }): Connection[] {
  const list = [...project.config.connections];
  const legacy = legacyTracker(project.config);
  if (legacy && !list.some((c) => c.id === legacy.id)) list.unshift(legacy);
  return list;
}

export function trackerConnections(project: { config: ProbeConfig }): Connection[] {
  return connections(project).filter((c) => c.kind === "jira" || c.kind === "linear");
}

export function slackConnections(project: { config: ProbeConfig }): Connection[] {
  return connections(project).filter((c) => c.kind === "slack");
}

export function findConnection(project: { config: ProbeConfig }, id: string): Connection | undefined {
  return connections(project).find((c) => c.id === id);
}

/** Name of a connection's token in the project's secrets. The old tracker keeps its old name. */
export function connectionTokenKey(conn: Pick<Connection, "id" | "kind" | "legacy">): string {
  return conn.legacy ? `tracker.${conn.kind}.token` : `connection.${conn.id}.token`;
}

export function connectionToken(project: { store: { dir: string } }, conn: Connection): string | null {
  return new Secrets(project.store.dir).getKey(connectionTokenKey(conn));
}

export function hasConnectionToken(project: { store: { dir: string } }, conn: Connection): boolean {
  return new Secrets(project.store.dir).hasKey(connectionTokenKey(conn));
}

/** What a connection still needs before Probe can use it, or null when it is ready. */
export function connectionMissing(conn: Connection, hasToken: boolean): string | null {
  if (conn.kind === "jira" && !conn.site) return "Jira needs the site address, e.g. https://acme.atlassian.net.";
  if (conn.kind === "jira" && !conn.email && /^(https?:\/\/)?[^/]+\.atlassian\.net(\/|$)/i.test(conn.site ?? ""))
    return "Jira Cloud needs the email of the account the API token belongs to.";
  if (!hasToken) return `No ${KIND_LABEL[conn.kind]} ${conn.kind === "slack" ? "token" : "API token"} on this machine for this project.`;
  if (conn.kind === "slack" && !(conn.channels ?? []).length) return "No channel added yet.";
  return null;
}

/** The label Studio shows. */
export function connectionLabel(conn: Connection): string {
  if (conn.label) return conn.label;
  if (conn.kind === "jira") return `Jira${conn.site ? ` · ${conn.site.replace(/^https?:\/\//, "")}` : ""}`;
  if (conn.kind === "linear") return `Linear${conn.team ? ` · ${conn.team}` : ""}`;
  return `Slack${conn.workspace ? ` · ${conn.workspace}` : ""}`;
}

/** An id for a new connection of this kind that the project does not use yet. */
export function newConnectionId(existing: Connection[], kind: ConnectionKind): string {
  if (!existing.some((c) => c.id === kind)) return kind;
  for (let n = 2; ; n++) if (!existing.some((c) => c.id === `${kind}-${n}`)) return `${kind}-${n}`;
}

/** What Studio sends to add or change a connection. */
export interface ConnectionBody {
  id?: string;
  kind?: string;
  label?: string | null;
  site?: string | null;
  email?: string | null;
  filter?: string | null;
  team?: string | null;
  buildField?: string | null;
  workspace?: string | null;
  days?: number | null;
  channels?: Partial<SlackChannel>[];
  /** Sealed on this machine; empty keeps the one already stored. */
  token?: string;
}

/** A plain site address: the token is sent there, so nothing else may ride along. */
export function cleanSite(raw: string | null | undefined): string | { error: string } {
  let site = raw?.trim().replace(/\/+$/, "") || "";
  if (!site) return { error: "Jira needs the site address, e.g. https://acme.atlassian.net" };
  if (!/^https?:\/\//i.test(site)) site = `https://${site}`;
  try {
    const url = new URL(site);
    if (url.username || url.password || url.search || url.hash) return { error: "Site: only the address, e.g. https://acme.atlassian.net" };
    return url.origin + url.pathname.replace(/\/+$/, "");
  } catch {
    return { error: "Site: a web address, e.g. https://acme.atlassian.net" };
  }
}

const text = (v: string | null | undefined) => v?.trim() || undefined;

/**
 * Adds a connection or changes one. Shared fields go to probe/probe.yaml, the email to this
 * machine's settings for the project, the token to the project's secrets. Returns the id, or an error.
 */
export function saveConnection(project: Project, body: ConnectionBody): { id: string } | { error: string } {
  const list = connections(project);
  const existing = body.id ? list.find((c) => c.id === body.id) : undefined;
  if (body.id && !existing) return { error: `This project has no connection ${body.id}.` };
  const kind = (existing?.kind ?? body.kind) as ConnectionKind;
  if (!["jira", "linear", "slack"].includes(kind)) return { error: "Kind: jira, linear or slack" };

  const conn: Connection = { id: existing && !existing.legacy ? existing.id : newConnectionId(list.filter((c) => !c.legacy), kind), kind, label: text(body.label) };
  if (kind === "jira") {
    const site = cleanSite(body.site ?? existing?.site);
    if (typeof site !== "string") return site;
    const email = text(body.email);
    if (email && !/^\S+@\S+$/.test(email)) return { error: "Email: the address of the Jira account the token belongs to" };
    Object.assign(conn, { site, filter: text(body.filter), buildField: text(body.buildField), email });
  } else if (kind === "linear") {
    Object.assign(conn, { filter: text(body.filter), team: text(body.team) });
  } else {
    const channels: SlackChannel[] = [];
    for (const c of body.channels ?? existing?.channels ?? []) {
      const id = String(c.id ?? "").trim();
      if (!/^[A-Z0-9]{6,20}$/.test(id) || channels.some((x) => x.id === id)) continue;
      const labels = Array.isArray(c.labels) ? c.labels.map((l) => String(l).trim()).filter(Boolean) : [];
      channels.push({ id, name: String(c.name ?? id).replace(/^#/, ""), search: c.search !== false, post: c.post === true, labels });
    }
    const days = body.days ?? existing?.days;
    Object.assign(conn, { workspace: text(body.workspace ?? existing?.workspace), channels, days: days && days > 0 ? Math.min(Math.round(days), 365) : undefined });
  }

  // An old single tracker that gets edited moves to the list, and its token moves with it.
  const secrets = new Secrets(project.store.dir);
  if (existing?.legacy) {
    const old = secrets.getKey(connectionTokenKey(existing));
    if (old && !body.token?.trim()) secrets.setKey(connectionTokenKey(conn), old);
    secrets.removeKey(connectionTokenKey(existing));
    retireLegacy(project);
  }
  const next = existing && !existing.legacy ? list.map((c) => (c.id === conn.id ? conn : c)) : [...list, conn];
  saveConnections(project.root, next.filter((c) => !c.legacy));
  if (kind === "jira") {
    const local = readLocalSettings(project.store.dir).connections ?? {};
    saveLocal(project.store.dir, { connections: { ...local, [conn.id]: conn.email ? { email: conn.email } : {} } });
  }
  if (body.token?.trim()) secrets.setKey(connectionTokenKey(conn), body.token.trim());
  project.config = loadConfig(project.root, project.store.dir);
  return { id: conn.id };
}

/** Clears the old single-tracker settings once the connection list holds it. */
function retireLegacy(project: Project): void {
  saveProject(project.root, { tickets: { tracker: null, site: null, filter: null, team: null, buildField: null } });
}

/** Removes a connection from the project, and its token from this machine. */
export function removeConnection(project: Project, id: string): boolean {
  const conn = findConnection(project, id);
  if (!conn) return false;
  new Secrets(project.store.dir).removeKey(connectionTokenKey(conn));
  if (conn.legacy) retireLegacy(project);
  else saveConnections(project.root, connections(project).filter((c) => c.id !== id && !c.legacy));
  project.config = loadConfig(project.root, project.store.dir);
  return true;
}

/** Forgets this machine's token for a connection, keeping the team's settings. */
export function disconnect(project: Project, id: string): boolean {
  const conn = findConnection(project, id);
  if (!conn) return false;
  new Secrets(project.store.dir).removeKey(connectionTokenKey(conn));
  return true;
}

// ── AI accounts: per machine and per project ────────────────────────────────
// A project can have several Claude accounts (work, personal, a client's API key) and choose one,
// with a model, for each kind of work: coding (writing changes and tests), review (checking a change
// against its ticket), testing (cards on a device, drafting cards, everything else).

export const ROLE_LABEL: Record<AiRole, string> = {
  coding: "Coding: writing changes and tests",
  review: "Review: checking a change against its ticket",
  testing: "Testing and everything else: cards, devices, drafts",
};

const apiKeyName = (id: string) => `ai.${id}.apiKey`;

export function aiSettings(project: Project) {
  const ai = readLocalSettings(project.store.dir).ai ?? {};
  const secrets = new Secrets(project.store.dir);
  const accounts = (ai.accounts ?? []).map((a) => ({ ...a, hasKey: a.mode === "apiKey" ? secrets.hasKey(apiKeyName(a.id)) : undefined }));
  return { accounts, use: ai.use ?? {}, roles: AI_ROLES.map((id) => ({ id, label: ROLE_LABEL[id] })), efforts: [...EFFORTS] };
}

export interface AiAccountBody {
  id?: string;
  name?: string;
  mode?: string;
  profileDir?: string | null;
  apiKey?: string;
}

/** Adds or changes one of the project's AI accounts. Returns its id or an error. */
export function saveAiAccount(project: Project, body: AiAccountBody): { id: string } | { error: string } {
  const ai = readLocalSettings(project.store.dir).ai ?? {};
  const accounts = [...(ai.accounts ?? [])];
  const name = text(body.name);
  if (!name) return { error: "Give the account a name you will recognise, e.g. Work Claude (Max)." };
  const mode = (body.mode ?? "default") as AiAccount["mode"];
  if (!["default", "profile", "apiKey"].includes(mode)) return { error: "Sign-in: default, profile or apiKey" };
  const profileDir = text(body.profileDir);
  if (mode === "profile" && !profileDir) return { error: "Give the folder that holds this account's own login, e.g. C:\\Users\\you\\.claude-work" };
  let id = body.id && accounts.some((a) => a.id === body.id) ? body.id : "";
  if (!id) {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "account";
    id = base;
    for (let n = 2; accounts.some((a) => a.id === id); n++) id = `${base}-${n}`;
  }
  const secrets = new Secrets(project.store.dir);
  if (mode === "apiKey" && body.apiKey?.trim()) secrets.setKey(apiKeyName(id), body.apiKey.trim());
  if (mode === "apiKey" && !secrets.hasKey(apiKeyName(id))) return { error: "Paste the API key for this account." };
  if (mode !== "apiKey") secrets.removeKey(apiKeyName(id));
  const account: AiAccount = { id, name, mode, profileDir: mode === "profile" ? profileDir : undefined };
  const at = accounts.findIndex((a) => a.id === id);
  if (at >= 0) accounts[at] = account;
  else accounts.push(account);
  saveLocal(project.store.dir, { ai: { ...ai, accounts } });
  return { id };
}

export function removeAiAccount(project: Project, id: string): void {
  const ai = readLocalSettings(project.store.dir).ai ?? {};
  new Secrets(project.store.dir).removeKey(apiKeyName(id));
  const use = Object.fromEntries(Object.entries(ai.use ?? {}).map(([role, u]) => [role, u?.account === id ? { ...u, account: undefined } : u]));
  saveLocal(project.store.dir, { ai: { accounts: (ai.accounts ?? []).filter((a) => a.id !== id), use } });
}

/** Which account and model each kind of work uses. */
export function saveAiUse(project: Project, use: Partial<Record<string, { account?: string; model?: string; effort?: string }>>): string | null {
  const ai = readLocalSettings(project.store.dir).ai ?? {};
  const ids = new Set((ai.accounts ?? []).map((a) => a.id));
  const next: AiSettings["use"] = {};
  for (const role of AI_ROLES) {
    const u = use[role];
    if (!u) continue;
    const account = u.account?.trim() || undefined;
    const model = u.model?.trim() || undefined;
    const effort = u.effort?.trim() || undefined;
    if (effort && !(EFFORTS as readonly string[]).includes(effort)) return `${ROLE_LABEL[role]}: effort is one of ${EFFORTS.join(", ")}`;
    if (account && !ids.has(account)) return `${ROLE_LABEL[role]}: unknown account ${account}`;
    if (model && !/^[\w.[\]:/-]{2,80}$/.test(model)) return `${ROLE_LABEL[role]}: a model name such as opus or claude-opus-5-5`;
    if (account || model || effort) next[role] = { account, model, effort };
  }
  saveLocal(project.store.dir, { ai: { ...ai, use: next } });
  return null;
}

/** The account and model a kind of work uses: its own choice, else the project's first account and the Agents model. */
export function aiFor(project: { config: ProbeConfig; store: { dir: string } }, role: AiRole = "testing"): { account?: AiAccount; model?: string; effort?: string } {
  const ai = readLocalSettings(project.store.dir).ai ?? {};
  const use = ai.use?.[role] ?? {};
  const account = (ai.accounts ?? []).find((a) => a.id === use.account) ?? (ai.accounts ?? [])[0];
  return { account, model: use.model, effort: use.effort };
}

/** Environment that points the agent CLI at an account. Empty for the CLI's own login. */
export function aiEnv(project: { config: ProbeConfig; store: { dir: string } }, account?: AiAccount): Record<string, string> {
  const codex = project.config.agents.runner === "codex";
  if (account?.mode === "profile" && account.profileDir) return codex ? { CODEX_HOME: account.profileDir } : { CLAUDE_CONFIG_DIR: account.profileDir };
  if (account?.mode === "apiKey") {
    const key = new Secrets(project.store.dir).getKey(apiKeyName(account.id));
    if (key) return codex ? { OPENAI_API_KEY: key } : { ANTHROPIC_API_KEY: key };
  }
  return {};
}
