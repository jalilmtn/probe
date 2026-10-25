import { listAccounts, Secrets } from "../accounts/accounts.js";
import { listCards } from "../cards/store.js";
import { agentModelSource, configPath, loadConfig, saveLocal, saveProject, type ProjectPatch } from "../core/config.js";
import { Adb } from "../devices/adb.js";
import { listDevices } from "../devices/android.js";
import { listAvds } from "../devices/select.js";
import { resolveApp } from "../engine/app.js";
import { defaultBase, gitState, listBranches } from "../engine/history.js";
import type { Project } from "../engine/project.js";
import { existsSync } from "node:fs";

/** Everything Studio's Project settings show: what Probe found, what is set, and where each value came from. */
export function projectSettings(project: Project) {
  const c = project.config;
  const devices = listDevices(Adb.forProject(project.root));
  return {
    configFile: existsSync(configPath(project.root)),
    app: resolveApp(project),
    appSet: c.app,
    devices: {
      avd: c.devices.avd ?? null,
      allowReal: c.devices.allowReal,
      avds: listAvds(project.root),
      connected: devices,
    },
    verify: { ...c.verify, base: c.verify.base ?? null, defaultBase: defaultBase(project.root, c.verify.base) },
    perf: c.perf,
    tickets: c.tickets,
    agents: { model: c.agents.model, source: agentModelSource(project.root, project.store.dir) },
  };
}

export interface ProjectSettingsBody extends ProjectPatch {
  /** This machine only (local.yaml). */
  devices?: { avd?: string | null; allowReal?: string[] };
}

const PACKAGE = /^[a-zA-Z][\w]*(\.[a-zA-Z_][\w]*)+$/;
const TASK = /^(:[\w.-]+)*:?[\w.-]+$/;

/** Validates and saves; the shared part goes to probe/probe.yaml, devices to this machine. Returns an error message or null. */
export function saveProjectSettings(project: Project, body: ProjectSettingsBody): string | null {
  const pkg = body.app?.package?.trim();
  if (pkg && !PACKAGE.test(pkg)) return "App id: an application id such as com.example.app.debug";
  const task = body.app?.installTask?.trim();
  if (task && !TASK.test(task)) return "Install task: a Gradle task such as :app:installDebug";
  const base = body.verify?.base?.trim();
  if (base && !listBranches(project.root).includes(base)) return `Base branch: ${base} is not a branch of this repository`;
  for (const [k, v] of Object.entries(body.perf ?? {})) {
    if (v !== null && v !== undefined && !(typeof v === "number" && v > 0)) return `Performance: ${k} must be a positive number`;
  }
  if (body.verify?.maxCards !== undefined && !(Number.isInteger(body.verify.maxCards) && body.verify.maxCards > 0)) return "Verify: max cards must be a whole number above 0";
  if (body.tickets?.pattern) {
    try {
      new RegExp(body.tickets.pattern);
    } catch {
      return "Tickets: the id pattern is not a valid regular expression";
    }
  }

  const { devices, ...shared } = body;
  if (shared.app) shared.app = { package: pkg ?? shared.app.package, installTask: task ?? shared.app.installTask };
  if (shared.verify && base !== undefined) shared.verify.base = base;
  if (Object.keys(shared).length) saveProject(project.root, shared);
  if (devices) {
    const current = project.config.devices;
    const avd = devices.avd === undefined ? current.avd : devices.avd || undefined;
    saveLocal(project.store.dir, { devices: { avd, allowReal: devices.allowReal ?? current.allowReal } });
  }
  project.config = loadConfig(project.root, project.store.dir);
  return null;
}

export interface SetupItem {
  id: string;
  label: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  /** Studio tab that fixes it. */
  action?: { label: string; tab: string };
}

/** What a new project still needs before agents can test it, each with where to fix it. */
export function setupChecklist(project: Project): SetupItem[] {
  const items: SetupItem[] = [];
  const app = resolveApp(project);
  items.push({
    id: "app",
    label: "App to test",
    status: app.package && app.installTask ? "ok" : app.installTask ? "warn" : "fail",
    detail: app.package
      ? `${app.package} · installed with ${app.installTask ?? "— (only what is already on the device)"}${app.packageSource === "probe.yaml" ? "" : ` · found in the ${app.packageSource}`}`
      : app.installTask
        ? `Install task ${app.installTask} found; the app id is read after the first install.`
        : "No Android application module found.",
    action: { label: "Project settings", tab: "settings" },
  });

  const devices = listDevices(Adb.forProject(project.root));
  const emulators = devices.filter((d) => d.emulator);
  const avds = listAvds(project.root);
  const avd = project.config.devices.avd ?? avds[0];
  items.push({
    id: "device",
    label: "Emulator",
    status: emulators.length || avd ? "ok" : "fail",
    detail: emulators.length
      ? `running: ${emulators.map((d) => d.serial).join(", ")}`
      : avd
        ? `${avd} starts when a run needs it${project.config.devices.avd ? "" : " (first image on this machine)"}`
        : "No emulator image on this machine. Create one in Android Studio → Device Manager (x86_64, API 34+).",
    action: { label: "Choose emulator", tab: "settings" },
  });

  const secrets = new Secrets(project.store.dir);
  const accounts = listAccounts(project.root);
  const withPassword = accounts.filter((a) => secrets.has(a.role, "password"));
  items.push({
    id: "accounts",
    label: "Test account",
    status: withPassword.length ? "ok" : "warn",
    detail: withPassword.length
      ? withPassword.map((a) => a.role).join(", ")
      : accounts.length
        ? `${accounts.map((a) => a.role).join(", ")}: no password on this machine yet`
        : "None yet. Agents can only test screens that need no login.",
    action: { label: "Add an account", tab: "settings" },
  });

  items.push({
    id: "model",
    label: "Agent model",
    status: "ok",
    detail: `${project.config.agents.model} (${agentModelSource(project.root, project.store.dir) === "default" ? "default" : "set"}) · use Test on my plan to check it works`,
    action: { label: "Settings", tab: "settings" },
  });

  const cards = listCards(project.root);
  items.push({
    id: "cards",
    label: "Feature cards",
    status: cards.some((c) => c.status === "approved") ? "ok" : "warn",
    detail: cards.length
      ? `${cards.length} cards, ${cards.filter((c) => c.status === "approved").length} approved${cards.some((c) => c.status === "approved") ? "" : ". Verify runs approved cards only: review drafts in Cards."}`
      : "None yet. Open a feature in Atlas and press Generate cards.",
    action: { label: cards.length ? "Review cards" : "Atlas", tab: cards.length ? "cards" : "atlas" },
  });

  const git = gitState(project.root);
  items.push({
    id: "git",
    label: "Branch",
    status: !git ? "warn" : git.branch ? "ok" : "warn",
    detail: !git ? "Not a git repository: verify and tickets need git." : git.branch ? `${git.branch} @ ${git.commit}` : `detached HEAD @ ${git.commit}`,
  });
  return items;
}

/**
 * The branch a person sees in Studio when they press a button. A run starts only while the
 * project is still on it: a checkout in a terminal or the IDE meanwhile would otherwise test,
 * and report on, code they never looked at.
 */
export function branchMismatch(project: Project, expected: string | undefined): string | null {
  if (expected === undefined) return null;
  const git = gitState(project.root);
  const now = git ? (git.branch ?? `detached@${git.commit}`) : "";
  return now === expected ? null : `The project is now on ${now || "no branch"}, not ${expected}. Check the branch, then press again.`;
}

/** Branch facts for Studio's header: what is checked out and what to watch out for. */
/** `withBranches` adds the list to pick a base from; the header polls without it. */
export function branchInfo(project: Project, withBranches = false) {
  const git = gitState(project.root);
  if (!git) return { git: null, branches: [], base: null, warnings: ["Not a git repository."] };
  const base = defaultBase(project.root, project.config.verify.base);
  const warnings: string[] = [];
  if (!git.branch) warnings.push(`Detached HEAD at ${git.commit}: runs test that commit, and results belong to no branch.`);
  const baseName = base?.replace(/^origin\//, "");
  if (git.branch && baseName && git.branch === baseName) warnings.push(`You are on ${git.branch}, the base branch itself: verify finds only uncommitted work. Check out your feature branch first.`);
  if (git.behind) warnings.push(`${git.branch} is ${git.behind} commit(s) behind ${git.upstream}: you are testing older code than the team has.`);
  if (git.dirty) warnings.push(`${git.dirty} uncommitted file(s) are part of what runs test.`);
  return { git, id: git.branch ?? `detached@${git.commit}`, branches: withBranches ? pickableBranches(project.root, [base, project.config.verify.base, git.branch]) : [], base, warnings };
}

/** A list a person can pick from: the usual bases, local branches, then the most recently active remote ones. */
// Sorting thousands of refs by date takes seconds and branches rarely appear mid-session.
let branchCache: { root: string; at: number; all: string[] } | null = null;

function pickableBranches(root: string, keep: (string | null | undefined)[]): string[] {
  if (!branchCache || branchCache.root !== root || Date.now() - branchCache.at > 60_000) branchCache = { root, at: Date.now(), all: listBranches(root) };
  const all = branchCache.all;
  const usual = ["origin/develop", "develop", "origin/main", "main", "origin/master", "master"].filter((b) => all.includes(b));
  const local = all.filter((b) => !b.includes("/") || !b.startsWith("origin/"));
  const wanted = [...keep.filter((b): b is string => !!b && all.includes(b)), ...usual, ...local.slice(0, 30), ...all.slice(0, 40)];
  return [...new Set(wanted)];
}
