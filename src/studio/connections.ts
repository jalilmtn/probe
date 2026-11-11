import { loadConfig, readLocalSettings, saveLocal, saveProject, WORK_STEPS, type Connection, type WorkStep } from "../core/config.js";
import {
  aiSettings,
  connectionLabel,
  connectionMissing,
  connections,
  findConnection,
  groupOf,
  hasConnectionToken,
  KIND_LABEL,
  trackerConnections,
} from "../connections/connections.js";
import { openSlack } from "../connections/slack.js";
import type { Project } from "../engine/project.js";
import { agentRunner } from "../agent/runners.js";
import { clearInbox } from "../tickets/inbox.js";
import { openTrackerFor } from "../tickets/tracker.js";
import { commitMessage, STEP_LABEL } from "../tickets/workbench.js";

// What Studio's Connections and Workbench settings show, for the project Studio has open.

function view(project: Project, c: Connection) {
  const hasToken = hasConnectionToken(project, c);
  return {
    id: c.id,
    kind: c.kind,
    kindLabel: KIND_LABEL[c.kind],
    group: groupOf(c.kind),
    label: connectionLabel(c),
    customLabel: c.label ?? null,
    site: c.site ?? null,
    email: c.email ?? null,
    filter: c.filter ?? null,
    team: c.team ?? null,
    buildField: c.buildField ?? null,
    workspace: c.workspace ?? null,
    days: c.days ?? 30,
    channels: c.channels ?? [],
    legacy: !!c.legacy,
    hasToken,
    missing: connectionMissing(c, hasToken),
  };
}

export function connectionsView(project: Project) {
  const ai = aiSettings(project);
  const runner = agentRunner(project.config.agents.runner);
  return {
    project: { name: project.name, root: project.root },
    connections: connections(project).map((c) => view(project, c)),
    ai: { ...ai, runner: runner.label, runnerId: runner.id, model: project.config.agents.model, models: runner.models },
  };
}

/** Asks the service who the token belongs to. */
export async function testConnection(project: Project, id: string): Promise<{ ok: boolean; message: string }> {
  const conn = findConnection(project, id);
  if (!conn) return { ok: false, message: "No such connection in this project." };
  try {
    if (conn.kind === "slack") {
      const me = await openSlack(project, conn).me();
      return { ok: true, message: `${me.user} in ${me.team}` };
    }
    const who = await openTrackerFor(project, conn).me();
    meCache.set(`${project.root}|${conn.id}`, who);
    return { ok: true, message: who };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

const meCache = new Map<string, string>();

/** Your name in each of the project's trackers, for telling your tickets from others'. */
export async function myNames(project: Project): Promise<string[]> {
  const names: string[] = [];
  for (const conn of trackerConnections(project)) {
    const key = `${project.root}|${conn.id}`;
    let name = meCache.get(key);
    if (!name) {
      try {
        name = await openTrackerFor(project, conn).me();
        meCache.set(key, name);
      } catch {
        continue;
      }
    }
    names.push(name);
  }
  return names;
}

export function afterConnectionChange(project: Project): void {
  clearInbox(project);
  for (const key of [...meCache.keys()]) if (key.startsWith(`${project.root}|`)) meCache.delete(key);
}

// ── Workbench settings ──────────────────────────────────────────────────────

export function workbenchView(project: Project) {
  const w = project.config.workbench;
  return {
    ...w,
    allSteps: WORK_STEPS.map((id) => ({ id, label: STEP_LABEL[id] })),
    preview: commitMessage(w.commitPattern, { key: "SHOP-412", title: "Checkout button does nothing on Android 14", labels: ["bug"] }, "checkout"),
  };
}

export interface WorkbenchBody {
  commitPattern?: string;
  notForMe?: { otherAssignee?: boolean; labels?: string[] | string; statuses?: string[] | string };
  steps?: string[];
}

const list = (v: string[] | string | undefined) => (Array.isArray(v) ? v : (v ?? "").split(",")).map((x) => x.trim()).filter(Boolean);

export function saveWorkbench(project: Project, body: WorkbenchBody): string | null {
  const pattern = body.commitPattern?.trim();
  if (pattern !== undefined && pattern && !/\{key\}/.test(pattern)) return "Commit message: include {key}, so each commit names its ticket.";
  if (pattern && pattern.length > 200) return "Commit message: keep the pattern under 200 characters.";
  const steps = body.steps?.filter((s): s is WorkStep => (WORK_STEPS as readonly string[]).includes(s));
  saveProject(project.root, {
    workbench: {
      commitPattern: pattern === undefined ? undefined : pattern || null,
      notForMe: body.notForMe
        ? { otherAssignee: body.notForMe.otherAssignee !== false, labels: list(body.notForMe.labels), statuses: list(body.notForMe.statuses) }
        : undefined,
      steps: steps === undefined ? undefined : steps.length ? steps : null,
    },
  });
  reload(project);
  return null;
}

/** Hides a ticket from your list on this machine, or shows it again. */
export function setHidden(project: Project, key: string, source: string | undefined, hidden: boolean): void {
  const id = `${source ?? ""}/${key}`;
  const current = readLocalSettings(project.store.dir).workbench?.hidden ?? [];
  const next = hidden ? [...new Set([...current, id])] : current.filter((h) => h !== id);
  saveLocal(project.store.dir, { workbench: next.length ? { hidden: next } : undefined });
  reload(project);
}

function reload(project: Project): void {
  project.config = loadConfig(project.root, project.store.dir);
}
