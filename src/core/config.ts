import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMap, parse, parseDocument, stringify } from "yaml";

/**
 * Per-project settings, read from `<project>/probe/probe.yaml`. Every field is optional:
 * Probe must work on a project that has never heard of it.
 */
export interface ProbeConfig {
  name?: string;
  features: {
    /** Top-level module folders whose next segment names a feature (e.g. `feature` → `:feature:chat:*`). */
    roots: string[];
    /**
     * Package prefixes whose next segment names a feature, for modules that hold several features
     * as packages or folders (`app.daywise` → `app.daywise.money.*` is "money"; in other projects
     * the folders, without src/lib, so `web.billing` → `web/src/billing/invoices/x.ts` is "invoices").
     */
    packages?: string[];
    /**
     * Feature name to glob(s) over project paths, for any project: `{ money: ["shared/src/commonMain/kotlin/app/demo/money", "web/src/money"] }`.
     * A class goes to the first entry matching its file or a folder it is in. Wins over `packages`.
     */
    map?: Record<string, string | string[]>;
  };
  /** Feature ids or module ids (prefix match) to leave out of scans and runs. */
  exclude: string[];
  /**
   * Areas of a project without a build tool Probe knows (generic and Node adapters): a list of
   * folder globs, each matching folder its own area (`[packages/*, services/*]`), or area name
   * to glob(s) (`{ engine: src/engine, web: [web/src, web/public] }`). Unset: top-level folders,
   * and the folders inside `src/`, `lib/`, `packages/`, `apps/` and the like.
   */
  areas?: string[] | Record<string, string | string[]>;
  unit: {
    /** Unit test task for Android modules. */
    androidTask: string;
    /** Unit test task for plain JVM modules. */
    jvmTask: string;
    /** Shell command that runs the unit tests (generic and Node adapters), e.g. `npm test`, `pytest`, `go test ./...`. */
    command?: string;
    /** Area id to the command that runs only that area's tests; areas not listed use `command`. */
    areas?: Record<string, string>;
    /** JUnit XML the command writes (file or folder, relative to the project). Unset: results come from the output and exit code. */
    junit?: string;
  };
  app: {
    /** Package agents test, e.g. the debug build's application id. */
    package?: string;
    /** Build task that installs it on the selected device, e.g. ":app:installDebug". */
    installTask?: string;
    /** Application id of the release build, when it differs from the debug one (no ".debug" suffix). */
    releasePackage?: string;
  };
  /** Where a finished build comes from when a run tests one instead of the working tree. */
  builds: {
    /** Firebase App Distribution: the Firebase app id, `1:1234567890:android:abc123`. */
    firebaseApp?: string;
    /** Google Play: the track builds are read from. The app is `app.releasePackage`. */
    playTrack: string;
    /** Git tag of a build number, `{build}` replaced, e.g. `v{build}`. Tells whether a build contains a commit. */
    tag?: string;
    /** Per machine: Google service account key file (JSON) with access to Play and Firebase. */
    serviceAccount?: string;
    /** Per machine: bundletool jar, for installing an .aab. */
    bundletool?: string;
  };
  /** The deployed web app agents test in a browser. */
  web: {
    /** Where it runs: a staging or preview URL, or a local dev server. */
    url?: string;
  };
  verify: {
    /** Branch a change is compared with. Unset: the first of origin/develop, develop, origin/main, main, master. */
    base?: string;
    /** Which cards of affected features run on a device: only approved ones, or drafts too. */
    cards: "approved" | "all";
    /** At most this many card runs per verify, so a wide change stays affordable. */
    maxCards: number;
  };
  /** Device-run thresholds. Going over one is a warning on the run, not a failure. */
  perf: {
    maxStartupMs: number;
    maxJankyPct: number;
    maxP90Ms: number;
    maxMemoryMb?: number;
  };
  tickets: {
    /** Ticket ids look like this (regex source); default PROJ-123. */
    pattern: string;
    /** Link for a ticket id, `{id}` replaced, e.g. https://jira.example.com/browse/{id}. */
    url?: string;
    /**
     * Command that files a ticket draft, `{title}` and `{file}` (a markdown body) replaced, e.g.
     * gh issue create --title {title} --body-file {file}. Unset: drafts are only copied, never filed.
     */
    fileCommand?: string;
    /** The tracker Studio's ticket inbox reads from. Its token stays on each machine. */
    tracker?: TrackerId;
    /** Jira: the site, e.g. https://acme.atlassian.net. */
    site?: string;
    /**
     * Which tickets the inbox lists. Jira: JQL (`status = "Ready for QA"`). Linear: status names,
     * comma separated (`Ready for QA, In Review`).
     */
    filter?: string;
    /** Linear: only this team's tickets (its key, the prefix of its ticket ids). */
    team?: string;
    /** Jira: the field that holds the build to test (name or id). Unset: the fix version. */
    buildField?: string;
    /** Per machine: the Jira account email the API token belongs to. */
    email?: string;
  };
  agents: {
    /** The coding-agent CLI every Probe agent runs on: Claude Code (default) or Codex CLI. */
    runner: AgentRunnerId;
    /**
     * Model for every Probe agent (cards, device runs, test writing), unless a run names one.
     * Fixed rather than inherited for Claude Code: the user's own default may be a model their
     * plan bills from usage credits, which would fail every background run. Empty means the
     * runner's own default (Codex: the model in the user's ~/.codex/config.toml).
     */
    model: string;
  };
  /**
   * Keeping features current while people code: an edit marks the features it touches stale,
   * and a check runs their unit tests, their manifest's test links and (with a manifest) an
   * agent that drafts corrections for review.
   */
  watch: {
    enabled: boolean;
    /** Let an agent draft manifest and brief corrections after a change. Costs one agent run per feature. */
    drafts: boolean;
    /** At most this many features per check; a wider change leaves the rest stale for a manual check. */
    maxFeatures: number;
    /**
     * How far an edit in a platform module reaches: 1 marks the areas that depend on it directly
     * as stale, 2 their dependents too, 0 only the area that owns the file.
     */
    impactDepth: number;
  };
  /** Security checks: which layers run and where the running app is, for runtime checks. */
  security: {
    /** Look dependencies up in the OSV database (api.osv.dev). Sends package names and versions, nothing else. */
    osv: boolean;
    /** Scan this many recent commits for secrets removed from the code but still in history. 0: off. */
    historyCommits: number;
    /** Local URL of the running web app or API for header, cookie and endpoint checks; localhost only. */
    url?: string;
    /** A run fails when an open finding is at least this severe. */
    failOn: "critical" | "high" | "medium" | "low" | "info";
    /** Check ids to never report (whole catalog prefixes work too: `IOS-`). */
    skip: string[];
    /** Path globs never scanned, on top of build output and vendored folders. */
    ignorePaths: string[];
  };
  /**
   * The project's connections: ticket trackers (more than one allowed) and Slack workspaces with
   * their channels. Shared with the team; each person's token and email stay on their machine.
   */
  connections: Connection[];
  /** How the ticket workbench decides which tickets are not yours, and how it commits. */
  workbench: WorkbenchConfig;
  /** Per machine, from the local settings file — never from the shared probe.yaml. */
  devices: {
    /** Emulator to boot when none is running. */
    avd?: string;
    /** Real phones agents may use. A phone usually carries someone's own accounts. */
    allowReal: string[];
  };
}

/** Kinds of connection a project can have. The AI account is per machine and never in probe.yaml. */
export const CONNECTION_KINDS = ["jira", "linear", "slack"] as const;
export type ConnectionKind = (typeof CONNECTION_KINDS)[number];

/** A Slack channel the project uses: searched for talk about a ticket, and maybe posted to. */
export interface SlackChannel {
  id: string;
  name: string;
  /** Look here for messages about a ticket. */
  search: boolean;
  /** Probe may post a result here, only when a person presses Post. */
  post: boolean;
  /** Only search this channel for tickets with one of these labels. Empty: every ticket. */
  labels: string[];
}

export interface Connection {
  /** Stable id within the project, e.g. "jira", "slack-acme". */
  id: string;
  kind: ConnectionKind;
  /** What Studio calls it, e.g. "Acme Jira". */
  label?: string;
  /** Jira: the site. */
  site?: string;
  /** Jira: JQL. Linear: status names, comma separated. */
  filter?: string;
  /** Linear: the team key. */
  team?: string;
  /** Jira: the build field. */
  buildField?: string;
  /** Per machine: the Jira account email. */
  email?: string;
  /** Slack: the workspace name, for the label. */
  workspace?: string;
  /** Slack: the channels this project uses. */
  channels?: SlackChannel[];
  /** Slack: how many days back to look (default 30). */
  days?: number;
  /** Read from the older single `tickets.tracker` settings. */
  legacy?: boolean;
}

/** Steps the workbench agent can take for each ticket, in this order. */
export const WORK_STEPS = ["context", "fix", "unitwrite", "unit", "ui", "validate", "commit", "comment"] as const;
export type WorkStep = (typeof WORK_STEPS)[number];

export interface WorkbenchConfig {
  /** `{key}`, `{title}`, `{type}`, `{area}` are replaced. */
  commitPattern: string;
  /** Tickets that are not yours: assigned to someone else, or with one of these labels or statuses. */
  notForMe: { otherAssignee: boolean; labels: string[]; statuses: string[] };
  /** Steps ticked when the workbench opens. */
  steps: WorkStep[];
  /** Per machine: tickets you hid by hand, as `source/key`. */
  hidden: string[];
}

export const DEFAULT_COMMIT_PATTERN = "{type}({area}): {title} [{key}]";

/** Ticket trackers the inbox can read. */
export const TRACKERS = ["jira", "linear"] as const;
export type TrackerId = (typeof TRACKERS)[number];

/** Coding-agent CLIs Probe can run its agents on. */
export const AGENT_RUNNERS = ["claude", "codex"] as const;
export type AgentRunnerId = (typeof AGENT_RUNNERS)[number];

/** The model a runner uses when nobody chose one. A model name only means something to its own CLI. */
export const RUNNER_DEFAULT_MODEL: Record<AgentRunnerId, string> = { claude: "sonnet", codex: "" };

export function isAgentRunner(value: unknown): value is AgentRunnerId {
  return AGENT_RUNNERS.includes(value as AgentRunnerId);
}

export const CONFIG_DIR = "probe";
export const CONFIG_FILE = "probe.yaml";
/** Machine-local settings, kept next to the local results rather than in the repo. */
export const LOCAL_CONFIG_FILE = "local.yaml";

const DEFAULTS: ProbeConfig = {
  features: { roots: ["feature", "features"] },
  exclude: [],
  unit: { androidTask: "testDebugUnitTest", jvmTask: "test" },
  app: {},
  builds: { playTrack: "internal" },
  web: {},
  verify: { cards: "approved", maxCards: 10 },
  perf: { maxStartupMs: 4000, maxJankyPct: 15, maxP90Ms: 32 },
  tickets: { pattern: "[A-Z][A-Z0-9]+-\\d+" },
  agents: { runner: "claude", model: RUNNER_DEFAULT_MODEL.claude },
  watch: { enabled: true, drafts: true, maxFeatures: 3, impactDepth: 1 },
  security: { osv: true, historyCommits: 300, failOn: "high", skip: [], ignorePaths: [] },
  devices: { allowReal: [] },
  connections: [],
  workbench: { commitPattern: DEFAULT_COMMIT_PATTERN, notForMe: { otherAssignee: true, labels: [], statuses: [] }, steps: ["context", "fix", "unitwrite", "unit", "commit"], hidden: [] },
};

export function configPath(root: string): string {
  return join(root, CONFIG_DIR, CONFIG_FILE);
}

export function loadConfig(root: string, localDir: string): ProbeConfig {
  const file = configPath(root);
  const raw = (existsSync(file) ? parse(readFileSync(file, "utf8")) ?? {} : {}) as Partial<ProbeConfig>;
  const local = readLocal(localDir);
  return {
    name: raw.name,
    features: { roots: raw.features?.roots ?? DEFAULTS.features.roots, packages: raw.features?.packages, map: raw.features?.map },
    exclude: raw.exclude ?? [],
    areas: raw.areas,
    unit: { ...DEFAULTS.unit, ...raw.unit },
    app: { ...raw.app },
    // Key files and tool paths differ per machine, so they never come from the shared file.
    builds: { ...DEFAULTS.builds, ...raw.builds, serviceAccount: local.builds?.serviceAccount, bundletool: local.builds?.bundletool },
    web: { ...raw.web },
    verify: { ...DEFAULTS.verify, ...raw.verify },
    perf: { ...DEFAULTS.perf, ...raw.perf },
    tickets: { ...DEFAULTS.tickets, ...raw.tickets, email: local.tickets?.email },
    agents: resolveAgents(raw.agents, local.agents),
    watch: { ...DEFAULTS.watch, ...raw.watch },
    security: { ...DEFAULTS.security, ...raw.security },
    devices: { avd: local.devices?.avd, allowReal: local.devices?.allowReal ?? [] },
    connections: readConnections(raw.connections, local.connections),
    workbench: readWorkbench(raw.workbench, local.workbench),
  };
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v).trim()).filter(Boolean) : [];
}

/** The shared list, checked, with this machine's email added. Entries Probe cannot use are left out. */
function readConnections(raw: unknown, local: LocalSettings["connections"]): Connection[] {
  if (!Array.isArray(raw)) return [];
  const out: Connection[] = [];
  for (const item of raw as Record<string, unknown>[]) {
    if (!item || typeof item !== "object") continue;
    const kind = item.kind as ConnectionKind;
    const id = String(item.id ?? "").trim();
    if (!CONNECTION_KINDS.includes(kind) || !/^[\w-]{1,40}$/.test(id) || out.some((c) => c.id === id)) continue;
    const text = (k: string) => (typeof item[k] === "string" && (item[k] as string).trim() ? (item[k] as string).trim() : undefined);
    const conn: Connection = { id, kind, label: text("label") };
    if (kind === "jira") Object.assign(conn, { site: text("site"), filter: text("filter"), buildField: text("buildField"), email: local?.[id]?.email });
    if (kind === "linear") Object.assign(conn, { filter: text("filter"), team: text("team") });
    if (kind === "slack") {
      conn.workspace = text("workspace");
      conn.days = typeof item.days === "number" && item.days > 0 ? Math.min(item.days, 365) : undefined;
      conn.channels = (Array.isArray(item.channels) ? (item.channels as Record<string, unknown>[]) : [])
        .filter((c) => c && typeof c.id === "string")
        .map((c) => ({ id: String(c.id), name: String(c.name ?? c.id), search: c.search !== false, post: c.post === true, labels: strings(c.labels) }));
    }
    out.push(conn);
  }
  return out;
}

function readWorkbench(raw: Partial<WorkbenchConfig> | undefined, local: LocalSettings["workbench"]): WorkbenchConfig {
  const d = DEFAULTS.workbench;
  const steps = strings(raw?.steps).filter((s): s is WorkStep => (WORK_STEPS as readonly string[]).includes(s));
  return {
    commitPattern: typeof raw?.commitPattern === "string" && raw.commitPattern.trim() ? raw.commitPattern : d.commitPattern,
    notForMe: {
      otherAssignee: typeof raw?.notForMe?.otherAssignee === "boolean" ? raw.notForMe.otherAssignee : d.notForMe.otherAssignee,
      labels: strings(raw?.notForMe?.labels),
      statuses: strings(raw?.notForMe?.statuses),
    },
    steps: steps.length ? steps : d.steps,
    hidden: strings(local?.hidden),
  };
}

/**
 * This machine's choice wins over the team's: each developer's plan decides which CLI and models
 * they can use. A model belongs to its runner, so a team model is dropped when this machine
 * switches to another runner.
 */
export function resolveAgents(team: Partial<ProbeConfig["agents"]> | undefined, machine: Partial<ProbeConfig["agents"]> | undefined): ProbeConfig["agents"] {
  const teamRunner = isAgentRunner(team?.runner) ? team.runner : DEFAULTS.agents.runner;
  const runner = isAgentRunner(machine?.runner) ? machine.runner : teamRunner;
  const model = machine?.model ?? (runner === teamRunner ? team?.model : undefined) ?? RUNNER_DEFAULT_MODEL[runner];
  return { runner, model: String(model ?? "") };
}

/** What a machine may set for itself, in `<store>/local.yaml`. */
export type LocalSettings = Partial<Pick<ProbeConfig, "devices">> & {
  agents?: Partial<ProbeConfig["agents"]>;
  builds?: Pick<ProbeConfig["builds"], "serviceAccount" | "bundletool">;
  tickets?: Pick<ProbeConfig["tickets"], "email">;
  /** Per connection id: what only this machine knows. */
  connections?: Record<string, { email?: string }>;
  /** Which AI account this project's agents use on this machine. */
  ai?: AiSettings;
  workbench?: { hidden?: string[] };
};

/**
 * The AI account a project's agents use on this machine. "default": the CLI's own login.
 * "profile": a separate CLI login kept in its own folder (CLAUDE_CONFIG_DIR, or CODEX_HOME for
 * Codex). "apiKey": an API key sealed in the project's secrets.
 */
export interface AiAccount {
  /** Stable id, e.g. "work". */
  id: string;
  /** What Studio calls it, e.g. "Work Claude (Max)". */
  name: string;
  /** "default": the CLI's own login. "profile": a separate login folder. "apiKey": a key sealed in the project's secrets. */
  mode: "default" | "profile" | "apiKey";
  profileDir?: string;
}

/** Kinds of agent work, each with its own account and model. */
export const AI_ROLES = ["coding", "review", "testing"] as const;
export type AiRole = (typeof AI_ROLES)[number];

export interface AiSettings {
  /** The project's Claude (or Codex) accounts on this machine. Empty: the CLI's own login. */
  accounts?: AiAccount[];
  /** Per kind of work: which account and model. Unset: the first account and the Agents model. */
  use?: Partial<Record<AiRole, { account?: string; model?: string }>>;
}

export function readLocalSettings(localDir: string): LocalSettings {
  return readLocal(localDir);
}

function readLocal(localDir: string): LocalSettings {
  const file = join(localDir, LOCAL_CONFIG_FILE);
  return (existsSync(file) ? (parse(readFileSync(file, "utf8")) ?? {}) : {}) as LocalSettings;
}

/** Merges into this machine's settings; sections not passed are kept, a section set to undefined is removed. */
export function saveLocal(localDir: string, patch: LocalSettings): void {
  const merged: Record<string, unknown> = { ...readLocal(localDir), ...patch };
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
  writeFileSync(join(localDir, LOCAL_CONFIG_FILE), stringify(merged));
}

export function readLocalAgents(localDir: string): LocalSettings["agents"] {
  return readLocal(localDir).agents;
}

/**
 * This machine's agent settings after a change from Studio, or an error message. `runner`: a
 * runner id, or ""/null for the team's. `model`: a name, or "" for the default. Switching runner
 * without naming a model drops the old one: a model name only means something to its own CLI.
 */
export function localAgents(current: LocalSettings["agents"], change: { runner?: string | null; model?: string }): LocalSettings["agents"] | string {
  const next: Partial<ProbeConfig["agents"]> = { ...current };
  if (change.runner !== undefined) {
    const runner = change.runner?.trim() || undefined;
    if (runner !== undefined && !isAgentRunner(runner)) return `Runner: one of ${AGENT_RUNNERS.join(", ")}`;
    if (runner !== current?.runner && change.model === undefined) delete next.model;
    if (runner) next.runner = runner;
    else delete next.runner;
  }
  if (change.model !== undefined) {
    const model = change.model.trim();
    if (model && !/^[\w.[\]:/-]{2,80}$/.test(model)) return "Model: a name the runner's --model accepts, e.g. sonnet";
    if (model) next.model = model;
    else delete next.model;
  }
  return Object.keys(next).length ? next : undefined;
}

export function saveLocalDevices(localDir: string, devices: ProbeConfig["devices"]): void {
  saveLocal(localDir, { devices });
}

export type SettingSource = "machine" | "project" | "default";

/** Where the agent model in effect comes from, for Studio. */
export function agentModelSource(root: string, localDir: string): SettingSource {
  const local = readLocal(localDir).agents;
  if (local?.model) return "machine";
  const team = readRaw(root).agents;
  const switched = isAgentRunner(local?.runner) && local.runner !== (isAgentRunner(team?.runner) ? team.runner : DEFAULTS.agents.runner);
  return team?.model && !switched ? "project" : "default";
}

/** Where the agent runner in effect comes from, for Studio. */
export function agentRunnerSource(root: string, localDir: string): SettingSource {
  if (isAgentRunner(readLocal(localDir).agents?.runner)) return "machine";
  return isAgentRunner(readRaw(root).agents?.runner) ? "project" : "default";
}

function readRaw(root: string): Partial<ProbeConfig> {
  const file = configPath(root);
  return (existsSync(file) ? (parse(readFileSync(file, "utf8")) ?? {}) : {}) as Partial<ProbeConfig>;
}

export const CONFIG_TEMPLATE = `# Probe settings for this project. Everything here is optional.
# Shared with the team: commit this folder. Local results live outside the repo.

# name: MyApp

features:
  # Module folders whose next segment is a feature: :feature:chat:impl -> "chat"
  roots: [feature, features]
  # Packages whose next segment is a feature, when one module holds several (a KMP "shared"):
  # packages: [com.example.app]   # com.example.app.money.* -> "money"
  # Or name each feature's files yourself, in any project (wins over packages):
  # map:
  #   money: ["shared/**/money", "composeApp/**/MoneyScreens.kt"]

# Leave features or modules out of scans and runs (prefix match).
exclude: []
#  - universe
#  - :feature:legacy

unit:
  androidTask: testDebugUnitTest
  jvmTask: test
  # Projects without Gradle: the command that runs the unit tests, optionally per area,
  # and where it writes JUnit XML (else results come from its output and exit code).
  # command: npm test
  # areas:
  #   engine: npx vitest run src/engine
  # junit: reports/junit.xml

# Areas of a project without Gradle (default: top-level folders and those inside src/,
# lib/, packages/, apps/...). A list makes each matching folder an area; a map names them.
# areas: [packages/*, services/*]
# areas:
#   engine: src/engine
#   web: [web/src, web/public]

# The app agents test on a device.
app:
  # package: com.example.app.debug
  # installTask: ":app:installDebug"
  # releasePackage: com.example.app   # the release build's id, when it differs

# Testing a finished build instead of the working tree (Studio -> Tickets, Verify).
# The Google service account key file is set per machine in Studio -> Settings.
# builds:
#   firebaseApp: "1:1234567890:android:abc123"   # Firebase App Distribution
#   playTrack: internal                          # Google Play track
#   tag: "v{build}"                              # git tag of a build number

# The deployed web app agents test in a browser.
# web:
#   url: https://staging.example.com

# Test accounts: add them in Studio -> Accounts (roles and usernames are saved to
# probe/hints/accounts.yaml; passwords stay encrypted on each machine).

# Probe's background agents: the coding-agent CLI they run on and its model.
# runner: claude (Claude Code, default) or codex (Codex CLI). Each machine can override both
# in Studio -> Settings. A model is a name that runner's --model accepts; leave it out for
# the runner's default (claude: sonnet, codex: your ~/.codex/config.toml model).
agents:
  runner: claude
  model: sonnet

# probe verify: what a change is checked against.
verify:
  # base: origin/develop
  cards: approved      # or: all (drafts too)
  maxCards: 10

# Device-run warnings (never failures on their own).
perf:
  maxStartupMs: 4000
  maxJankyPct: 15
  maxP90Ms: 32
  # maxMemoryMb: 400

# Keeping features current while you code (edit hooks, Studio's file watcher).
watch:
  enabled: true
  drafts: true         # an agent drafts manifest and brief corrections for review
  maxFeatures: 3
  impactDepth: 1       # a platform edit marks the areas depending on it stale; 2 reaches theirs, 0 is off

tickets:
  # pattern: 'PROJ-\\d+'
  # url: https://jira.example.com/browse/{id}
  # fileCommand: gh issue create --title {title} --body-file {file}
  # The ticket inbox (Studio -> Tickets). Connect in Studio -> Settings; tokens stay on each machine.
  # tracker: jira                      # or: linear
  # site: https://acme.atlassian.net   # Jira only
  # filter: 'status = "Ready for QA"'  # Jira: JQL. Linear: status names, comma separated
`;

export function isExcluded(config: ProbeConfig, featureId: string, moduleId?: string): boolean {
  return config.exclude.some(
    (rule) => featureId === rule || featureId.startsWith(`${rule}:`) || (moduleId?.startsWith(rule) ?? false),
  );
}

/** Shared settings Studio may change. A value of null removes the key. */
export interface ProjectPatch {
  app?: { package?: string | null; installTask?: string | null; releasePackage?: string | null };
  builds?: { firebaseApp?: string | null; playTrack?: string | null; tag?: string | null };
  web?: { url?: string | null };
  verify?: { base?: string | null; cards?: "approved" | "all"; maxCards?: number };
  perf?: { maxStartupMs?: number; maxJankyPct?: number; maxP90Ms?: number; maxMemoryMb?: number | null };
  tickets?: {
    pattern?: string | null;
    url?: string | null;
    fileCommand?: string | null;
    tracker?: TrackerId | null;
    site?: string | null;
    filter?: string | null;
    team?: string | null;
    buildField?: string | null;
  };
  agents?: { runner?: AgentRunnerId | null; model?: string | null };
  workbench?: { commitPattern?: string | null; notForMe?: WorkbenchConfig["notForMe"] | null; steps?: WorkStep[] | null };
}

/** Replaces the shared connections list in probe/probe.yaml. Machine-only fields are never written. */
export function saveConnections(root: string, list: Connection[]): void {
  const file = configPath(root);
  if (!existsSync(file)) {
    mkdirSync(join(root, CONFIG_DIR), { recursive: true });
    writeFileSync(file, CONFIG_TEMPLATE);
  }
  const doc = parseDocument(readFileSync(file, "utf8"));
  const shared = list
    .filter((c) => !c.legacy)
    .map(({ email: _email, legacy: _legacy, ...c }) => Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined && v !== "")));
  if (shared.length) doc.set("connections", doc.createNode(shared));
  else doc.delete("connections");
  writeFileSync(file, doc.toString());
}

/**
 * Writes shared settings into probe/probe.yaml, creating it from the template the first time.
 * Edits the document in place, so the comments and anything a person wrote by hand stay.
 */
export function saveProject(root: string, patch: ProjectPatch): void {
  const file = configPath(root);
  if (!existsSync(file)) {
    mkdirSync(join(root, CONFIG_DIR), { recursive: true });
    writeFileSync(file, CONFIG_TEMPLATE);
  }
  const doc = parseDocument(readFileSync(file, "utf8"));
  for (const [section, values] of Object.entries(patch)) {
    // "app:" with only comments under it parses as null, which setIn cannot descend into.
    const added = !doc.has(section);
    if (!isMap(doc.get(section))) doc.set(section, doc.createNode({}));
    for (const [key, value] of Object.entries(values ?? {})) {
      if (value === undefined) continue;
      if (value === null || value === "") doc.deleteIn([section, key]);
      else doc.setIn([section, key], value);
    }
    // A section this call added and left empty (every value cleared) is not written at all.
    const node = doc.get(section);
    if (added && isMap(node) && node.items.length === 0) doc.delete(section);
  }
  writeFileSync(file, doc.toString());
}
