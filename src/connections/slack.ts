import type { Connection, SlackChannel } from "../core/config.js";
import { connectionLabel, connectionMissing, connectionToken, slackConnections } from "./connections.js";

// Slack is read to find what people said about a ticket, in the channels the project chose. It is
// written to only when a person presses Post. A bot token (xoxb-) reads channel history, so the
// bot must be invited to each channel; a user token (xoxp-) can read any channel its user is in.

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 20_000;

/** A Slack message that mentions a ticket. */
export interface SlackMatch {
  connection: string;
  connectionLabel: string;
  channel: string;
  channelName: string;
  ts: string;
  user: string;
  text: string;
  at: string;
  link: string;
  /** Replies under it, when it started a thread. */
  replies: number;
}

export interface ChannelChoice {
  id: string;
  name: string;
  isPrivate: boolean;
  isMember: boolean;
}

export class Slack {
  private teamUrl: string | null = null;
  private readonly users = new Map<string, string>();

  constructor(
    private readonly token: string,
    private readonly fetcher: Fetch = fetch,
  ) {}

  private async call<T>(method: string, params: Record<string, string | number> = {}, post = false): Promise<T> {
    const query = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
    const res = await this.fetcher(post ? `https://slack.com/api/${method}` : `https://slack.com/api/${method}?${query}`, {
      method: post ? "POST" : "GET",
      headers: { authorization: `Bearer ${this.token}`, ...(post ? { "content-type": "application/json; charset=utf-8" } : {}) },
      body: post ? JSON.stringify(params) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Slack answered ${res.status}.`);
    const body = (await res.json()) as { ok: boolean; error?: string; needed?: string } & T;
    if (!body.ok) throw new Error(`Slack: ${slackError(body.error, body.needed)}`);
    return body;
  }

  /** Who the token belongs to, and the workspace. */
  async me(): Promise<{ user: string; team: string; url: string }> {
    const who = await this.call<{ user?: string; team?: string; url?: string }>("auth.test");
    this.teamUrl = who.url ?? null;
    return { user: who.user ?? "connected", team: who.team ?? "", url: who.url ?? "" };
  }

  /** Channels the token can see, to choose from. */
  async channels(): Promise<ChannelChoice[]> {
    const out: ChannelChoice[] = [];
    let cursor = "";
    for (let page = 0; page < 10; page++) {
      const body = await this.call<{ channels: { id: string; name: string; is_private?: boolean; is_member?: boolean }[]; response_metadata?: { next_cursor?: string } }>(
        "conversations.list",
        { types: "public_channel,private_channel", exclude_archived: "true", limit: 200, ...(cursor ? { cursor } : {}) },
      );
      out.push(...body.channels.map((c) => ({ id: c.id, name: c.name, isPrivate: !!c.is_private, isMember: !!c.is_member })));
      cursor = body.response_metadata?.next_cursor ?? "";
      if (!cursor) break;
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Messages of a channel since `oldest` (seconds), newest first, at most `max`. */
  async history(channel: string, oldest: number, max = 1000): Promise<{ ts: string; user?: string; bot_id?: string; text?: string; reply_count?: number }[]> {
    const out: { ts: string; user?: string; text?: string; reply_count?: number }[] = [];
    let cursor = "";
    while (out.length < max) {
      const body = await this.call<{ messages: { ts: string; user?: string; text?: string; reply_count?: number }[]; has_more?: boolean; response_metadata?: { next_cursor?: string } }>(
        "conversations.history",
        { channel, oldest, limit: 200, ...(cursor ? { cursor } : {}) },
      );
      out.push(...body.messages);
      cursor = body.response_metadata?.next_cursor ?? "";
      if (!body.has_more || !cursor) break;
    }
    return out.slice(0, max);
  }

  async userName(id: string): Promise<string> {
    if (!id) return "someone";
    const known = this.users.get(id);
    if (known) return known;
    try {
      const body = await this.call<{ user: { real_name?: string; name?: string; profile?: { display_name?: string } } }>("users.info", { user: id });
      const name = body.user.profile?.display_name || body.user.real_name || body.user.name || id;
      this.users.set(id, name);
      return name;
    } catch {
      return id;
    }
  }

  link(channel: string, ts: string): string {
    const base = (this.teamUrl ?? "https://slack.com/").replace(/\/?$/, "/");
    return `${base}archives/${channel}/p${ts.replace(".", "")}`;
  }

  async post(channel: string, text: string): Promise<void> {
    await this.call("chat.postMessage", { channel, text }, true);
  }
}

function slackError(code: string | undefined, needed?: string): string {
  switch (code) {
    case "invalid_auth":
    case "not_authed":
    case "token_revoked":
    case "token_expired":
      return "the token is not accepted (expired or revoked). Paste a new one.";
    case "not_in_channel":
      return "the bot is not in that channel. In Slack, type /invite @your-bot in the channel.";
    case "channel_not_found":
      return "channel not found, or the token cannot see it.";
    case "missing_scope":
      return `the token is missing a permission${needed ? ` (${needed})` : ""}. Add it to the Slack app and reinstall it.`;
    case "ratelimited":
      return "too many requests; try again in a minute.";
    default:
      return code ?? "unknown error";
  }
}

/** Whether a message is about a ticket: its key as a word, or (long enough) its exact title. */
export function mentionsTicket(text: string, key: string, title?: string): boolean {
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`(^|[^A-Za-z0-9])${k}(?![0-9])`, "i").test(text)) return true;
  const t = title?.trim().toLowerCase();
  return !!t && t.length >= 16 && text.toLowerCase().includes(t);
}

/** Whether a channel is searched for this ticket: switched on, and its labels (if any) match. */
export function channelApplies(channel: SlackChannel, labels: string[]): boolean {
  if (!channel.search) return false;
  if (!channel.labels.length) return true;
  const have = new Set(labels.map((l) => l.toLowerCase()));
  return channel.labels.some((l) => have.has(l.toLowerCase()));
}

export function openSlack(project: { store: { dir: string } }, conn: Connection, fetcher?: Fetch): Slack {
  const token = connectionToken(project, conn);
  if (!token) throw new Error(`${connectionLabel(conn)}: no token on this machine for this project.`);
  return new Slack(token, fetcher);
}

const HISTORY_MS = 5 * 60_000;
const historyCache = new Map<string, { at: number; messages: Awaited<ReturnType<Slack["history"]>> }>();

/**
 * What people said about a ticket in the project's Slack channels, newest first. A channel that
 * cannot be read is reported in `errors`, and the others are still searched.
 */
export async function ticketDiscussion(
  project: { config: import("../core/config.js").ProbeConfig; store: { dir: string } },
  ticket: { id: string; title?: string; labels?: string[] },
  fetcher?: Fetch,
): Promise<{ matches: SlackMatch[]; errors: string[]; searched: string[] }> {
  const matches: SlackMatch[] = [];
  const errors: string[] = [];
  const searched: string[] = [];
  for (const conn of slackConnections(project)) {
    const hasToken = connectionToken(project, conn) !== null;
    const missing = connectionMissing(conn, hasToken);
    if (missing) {
      errors.push(`${connectionLabel(conn)}: ${missing}`);
      continue;
    }
    const slack = openSlack(project, conn, fetcher);
    try {
      await slack.me();
    } catch (e) {
      errors.push(`${connectionLabel(conn)}: ${(e as Error).message}`);
      continue;
    }
    const oldest = Math.floor(Date.now() / 1000) - (conn.days ?? 30) * 86400;
    for (const channel of (conn.channels ?? []).filter((c) => channelApplies(c, ticket.labels ?? []))) {
      searched.push(`#${channel.name}`);
      try {
        const key = `${project.store.dir}|${conn.id}|${channel.id}|${oldest - (oldest % 3600)}`;
        let hit = historyCache.get(key);
        if (!hit || Date.now() - hit.at > HISTORY_MS) {
          hit = { at: Date.now(), messages: await slack.history(channel.id, oldest) };
          historyCache.set(key, hit);
        }
        for (const m of hit.messages) {
          if (!m.text || !mentionsTicket(m.text, ticket.id, ticket.title)) continue;
          matches.push({
            connection: conn.id,
            connectionLabel: connectionLabel(conn),
            channel: channel.id,
            channelName: channel.name,
            ts: m.ts,
            user: await slack.userName(m.user ?? ""),
            text: m.text.slice(0, 1200),
            at: new Date(Number(m.ts) * 1000).toISOString(),
            link: slack.link(channel.id, m.ts),
            replies: m.reply_count ?? 0,
          });
        }
      } catch (e) {
        errors.push(`#${channel.name}: ${(e as Error).message}`);
      }
    }
  }
  matches.sort((a, b) => b.ts.localeCompare(a.ts));
  return { matches, errors, searched };
}

/** The discussion as plain text for an agent's prompt. */
export function discussionText(matches: SlackMatch[], max = 20): string {
  if (!matches.length) return "";
  return matches
    .slice(0, max)
    .map((m) => `[#${m.channelName} · ${m.user} · ${m.at.slice(0, 16).replace("T", " ")}${m.replies ? ` · ${m.replies} replies` : ""}]\n${m.text}`)
    .join("\n\n");
}
