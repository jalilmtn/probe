import { connectionLabel, connectionMissing, connectionToken, trackerConnections } from "../connections/connections.js";
import type { Connection, ProbeConfig, TrackerId } from "../core/config.js";

// The tracker is where tickets live (Jira, Linear). Probe reads tickets from it for the inbox
// and writes exactly one thing back: a comment with a run's result, when a person presses Post.

/** A ticket as the inbox shows it, whichever tracker it came from. */
export interface TrackerTicket {
  id: string;
  title: string;
  /** Plain text: the description and acceptance criteria as written. */
  description: string;
  status: string;
  author?: string;
  assignee?: string;
  url: string;
  updatedAt: string;
  labels: string[];
  /** The build to test, from the ticket's build field or its text. */
  build?: string;
  /** The connection it came from, when the project has more than one tracker. */
  source?: string;
  sourceLabel?: string;
}

export interface Tracker {
  readonly id: TrackerId;
  /** Who the token belongs to; throws with the tracker's own message when it is not accepted. */
  me(): Promise<string>;
  list(limit?: number): Promise<TrackerTicket[]>;
  get(id: string): Promise<TrackerTicket>;
  /** Adds a comment. `body` uses `bold()` for emphasis, since the trackers disagree on markup. */
  comment(id: string, body: string): Promise<void>;
  bold(text: string): string;
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Name of the tracker token in the machine's secrets. */
export const tokenKey = (tracker: TrackerId): string => `tracker.${tracker}.token`;

export const TRACKER_LABEL: Record<TrackerId, string> = { jira: "Jira", linear: "Linear" };

/** What still has to be filled in before the tracker can be reached, or null when it is ready. */
export function trackerMissing(config: ProbeConfig["tickets"], hasToken: boolean): string | null {
  if (!config.tracker) return "No ticket tracker chosen.";
  if (config.tracker === "jira" && !config.site) return "Jira needs the site address, e.g. https://acme.atlassian.net.";
  if (!hasToken) return `No ${TRACKER_LABEL[config.tracker]} API token on this machine.`;
  return null;
}

/**
 * A tracker of the project with this machine's token: the connection named, else the first one.
 * Throws saying what is missing.
 */
export function openTracker(project: { config: ProbeConfig; store: { dir: string } }, fetcher: Fetch = fetch, source?: string): Tracker {
  const all = trackerConnections(project);
  const conn = source ? all.find((c) => c.id === source) : all[0];
  if (!conn) throw new Error(source ? `This project has no tracker connection ${source}.` : "No ticket tracker chosen. Connect it in Studio → Settings → Connections.");
  return openTrackerFor(project, conn, fetcher);
}

export function openTrackerFor(project: { config: ProbeConfig; store: { dir: string } }, conn: Connection, fetcher: Fetch = fetch): Tracker {
  const token = connectionToken(project, conn);
  const missing = connectionMissing(conn, token !== null);
  if (missing) throw new Error(`${connectionLabel(conn)}: ${missing} Connect it in Studio → Settings → Connections.`);
  const config: ProbeConfig["tickets"] = { pattern: project.config.tickets.pattern, tracker: conn.kind as TrackerId, site: conn.site, filter: conn.filter, team: conn.team, buildField: conn.buildField, email: conn.email };
  return conn.kind === "jira" ? new Jira(config, token!, fetcher) : new Linear(config, token!, fetcher);
}

/** A build number written in a ticket's text: "Build: 142", "build #1.4.2", "build 142". */
export function buildInText(text: string): string | undefined {
  return /\bbuild(?:\s+(?:number|no\.?|version))?\s*[:#=]?\s*v?(\d[\w.+-]{0,30})/i.exec(text)?.[1]?.replace(/[.,;]+$/, "");
}

async function readJson(res: Response, what: string): Promise<unknown> {
  const body = await res.text();
  if (!res.ok) {
    let detail = body.slice(0, 300);
    try {
      const parsed = JSON.parse(body) as { errorMessages?: string[]; message?: string; errors?: unknown };
      detail = parsed.errorMessages?.join("; ") || parsed.message || (parsed.errors ? JSON.stringify(parsed.errors).slice(0, 300) : detail);
    } catch {
      // Not JSON (a login page, a proxy error): the first characters are all there is.
    }
    const hint = /Connect Session Auth Token/i.test(body)
      ? " Jira Cloud wants the account email with an API token: add the email in Studio → Settings → Connections."
      : res.status === 401 || res.status === 403
        ? " Check the token (and, for Jira, the email it belongs to)."
        : "";
    throw new Error(`${what} answered ${res.status}: ${detail || res.statusText}.${hint}`);
  }
  return body ? JSON.parse(body) : {};
}

const TIMEOUT_MS = 25_000;

// ── Jira ──────────────────────────────────────────────────────────────────────

interface JiraIssue {
  key: string;
  fields: Record<string, unknown> & {
    summary?: string;
    description?: unknown;
    status?: { name?: string };
    reporter?: { displayName?: string };
    assignee?: { displayName?: string } | null;
    updated?: string;
    labels?: string[];
    fixVersions?: { name?: string }[];
  };
}

/** Jira's "not done yet" tickets, newest first, when no filter is set. */
export const JIRA_DEFAULT_FILTER = "statusCategory != Done ORDER BY updated DESC";

/**
 * Jira Cloud (email + API token) and Data Center (a personal access token, no email). Uses
 * REST v2, where descriptions and comments are plain text rather than Atlassian's document JSON.
 */
export class Jira implements Tracker {
  readonly id = "jira" as const;
  private readonly site: string;
  private buildFieldId: string | null | undefined;

  constructor(
    private readonly config: ProbeConfig["tickets"],
    private readonly token: string,
    private readonly fetcher: Fetch,
  ) {
    this.site = (config.site ?? "").replace(/\/+$/, "");
  }

  private async call(path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
    const auth = this.config.email ? `Basic ${Buffer.from(`${this.config.email}:${this.token}`).toString("base64")}` : `Bearer ${this.token}`;
    return this.fetcher(`${this.site}${path}`, {
      method: init.method ?? "GET",
      headers: { authorization: auth, accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }

  async me(): Promise<string> {
    const who = (await readJson(await this.call("/rest/api/2/myself"), "Jira")) as { displayName?: string; emailAddress?: string; name?: string };
    return who.displayName ?? who.emailAddress ?? who.name ?? "connected";
  }

  /** The id of the configured build field: given as an id, or found by its name. Null when there is none. */
  private async buildField(): Promise<string | null> {
    if (this.buildFieldId !== undefined) return this.buildFieldId;
    const wanted = this.config.buildField?.trim();
    if (!wanted) return (this.buildFieldId = null);
    if (/^customfield_\d+$/.test(wanted)) return (this.buildFieldId = wanted);
    const fields = (await readJson(await this.call("/rest/api/2/field"), "Jira")) as { id: string; name: string }[];
    const found = fields.find((f) => f.name.toLowerCase() === wanted.toLowerCase() || f.id === wanted);
    if (!found) throw new Error(`Jira has no field named "${wanted}". Fix the build field in Studio → Settings → Connections.`);
    return (this.buildFieldId = found.id);
  }

  private async fields(): Promise<string[]> {
    const build = await this.buildField();
    return ["summary", "description", "status", "reporter", "assignee", "updated", "labels", "fixVersions", ...(build ? [build] : [])];
  }

  private ticket(issue: JiraIssue, buildField: string | null): TrackerTicket {
    const f = issue.fields;
    const description = jiraText(f.description);
    return {
      id: issue.key,
      title: f.summary ?? "",
      description,
      status: f.status?.name ?? "",
      author: f.reporter?.displayName,
      assignee: f.assignee?.displayName,
      url: `${this.site}/browse/${issue.key}`,
      updatedAt: f.updated ?? "",
      labels: f.labels ?? [],
      build: (buildField ? fieldText(f[buildField]) : undefined) || buildInText(description) || f.fixVersions?.[0]?.name || undefined,
    };
  }

  async list(limit = 50): Promise<TrackerTicket[]> {
    const body = { jql: this.config.filter?.trim() || JIRA_DEFAULT_FILTER, maxResults: limit, fields: await this.fields() };
    // Jira Cloud replaced /search with /search/jql; Data Center only has the old one.
    let res = await this.call("/rest/api/2/search/jql", { method: "POST", body });
    if (res.status === 404 || res.status === 405) res = await this.call("/rest/api/2/search", { method: "POST", body });
    const found = (await readJson(res, "Jira")) as { issues?: JiraIssue[] };
    const build = await this.buildField();
    return (found.issues ?? []).map((i) => this.ticket(i, build));
  }

  async get(id: string): Promise<TrackerTicket> {
    const fields = (await this.fields()).join(",");
    const issue = (await readJson(await this.call(`/rest/api/2/issue/${encodeURIComponent(id)}?fields=${fields}`), "Jira")) as JiraIssue;
    return this.ticket(issue, await this.buildField());
  }

  async comment(id: string, body: string): Promise<void> {
    await readJson(await this.call(`/rest/api/2/issue/${encodeURIComponent(id)}/comment`, { method: "POST", body: { body } }), "Jira");
  }

  bold(text: string): string {
    return `*${text}*`;
  }
}

/** A Jira field value as text: a string, a number, an option or version (`name`/`value`), or a list of those. */
function fieldText(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string" || typeof value === "number") return String(value).trim() || undefined;
  if (Array.isArray(value)) return value.map(fieldText).filter(Boolean).join(", ") || undefined;
  const o = value as { name?: unknown; value?: unknown };
  return fieldText(o.name ?? o.value);
}

/** Description text. v2 gives a string; a document tree (v3 shape) is flattened, in case a proxy upgrades the call. */
function jiraText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const node = value as { text?: string; type?: string; content?: unknown[] };
  const inner = (node.content ?? []).map(jiraText).join("");
  return (node.text ?? "") + inner + (["paragraph", "heading", "listItem", "hardBreak"].includes(node.type ?? "") ? "\n" : "");
}

// ── Linear ────────────────────────────────────────────────────────────────────

interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  url: string;
  updatedAt: string;
  state?: { name?: string };
  creator?: { name?: string } | null;
  assignee?: { name?: string } | null;
  labels?: { nodes?: { name: string }[] };
}

const LINEAR_FIELDS = "id identifier title description url updatedAt state { name } creator { name } assignee { name } labels { nodes { name } }";

export class Linear implements Tracker {
  readonly id = "linear" as const;

  constructor(
    private readonly config: ProbeConfig["tickets"],
    private readonly token: string,
    private readonly fetcher: Fetch,
  ) {}

  private async query<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await this.fetcher("https://api.linear.app/graphql", {
      method: "POST",
      headers: { authorization: this.token, "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await readJson(res, "Linear")) as { data?: T; errors?: { message: string }[] };
    if (body.errors?.length) throw new Error(`Linear: ${body.errors.map((e) => e.message).join("; ")}`);
    return body.data as T;
  }

  async me(): Promise<string> {
    const data = await this.query<{ viewer: { name?: string; email?: string } }>("{ viewer { name email } }");
    return data.viewer.name ?? data.viewer.email ?? "connected";
  }

  private ticket(issue: LinearIssue): TrackerTicket {
    const labels = issue.labels?.nodes?.map((l) => l.name) ?? [];
    const description = issue.description ?? "";
    return {
      id: issue.identifier,
      title: issue.title,
      description,
      status: issue.state?.name ?? "",
      author: issue.creator?.name,
      assignee: issue.assignee?.name,
      url: issue.url,
      updatedAt: issue.updatedAt,
      labels,
      // Linear has no custom fields: the build comes from a "build:142" label or the text.
      build: labels.map((l) => /^build[:\s-]+v?(\S+)$/i.exec(l)?.[1]).find(Boolean) ?? buildInText(description),
    };
  }

  async list(limit = 50): Promise<TrackerTicket[]> {
    const states = (this.config.filter ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    // No status named: everything someone is working on or about to (not backlog, done or cancelled).
    const filter: Record<string, unknown> = { state: states.length ? { name: { in: states } } : { type: { in: ["started", "unstarted"] } } };
    if (this.config.team?.trim()) filter.team = { key: { eq: this.config.team.trim() } };
    const data = await this.query<{ issues: { nodes: LinearIssue[] } }>(
      `query Inbox($filter: IssueFilter, $first: Int) { issues(filter: $filter, first: $first, orderBy: updatedAt) { nodes { ${LINEAR_FIELDS} } } }`,
      { filter, first: limit },
    );
    return data.issues.nodes.map((i) => this.ticket(i));
  }

  private async issue(id: string): Promise<LinearIssue> {
    const data = await this.query<{ issue: LinearIssue | null }>(`query Ticket($id: String!) { issue(id: $id) { ${LINEAR_FIELDS} } }`, { id });
    if (!data.issue) throw new Error(`Linear has no ticket ${id}.`);
    return data.issue;
  }

  async get(id: string): Promise<TrackerTicket> {
    return this.ticket(await this.issue(id));
  }

  async comment(id: string, body: string): Promise<void> {
    const issue = await this.issue(id);
    const data = await this.query<{ commentCreate: { success: boolean } }>(
      "mutation Comment($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }",
      { issueId: issue.id, body },
    );
    if (!data.commentCreate.success) throw new Error(`Linear did not accept the comment on ${id}.`);
  }

  bold(text: string): string {
    return `**${text}**`;
  }
}
