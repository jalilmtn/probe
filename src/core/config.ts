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
  };
  /** Feature ids or module ids (prefix match) to leave out of scans and runs. */
  exclude: string[];
  unit: {
    /** Unit test task for Android modules. */
    androidTask: string;
    /** Unit test task for plain JVM modules. */
    jvmTask: string;
  };
  app: {
    /** Package agents test, e.g. the debug build's application id. */
    package?: string;
    /** Build task that installs it on the selected device, e.g. ":app:installDebug". */
    installTask?: string;
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
  };
  agents: {
    /**
     * Model for every Probe agent (cards, device runs, test writing), unless a run names one.
     * Fixed rather than inherited: the user's own Claude Code default may be a model their plan
     * bills from usage credits, which would fail every background run.
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
  };
  /** Per machine, from the local settings file — never from the shared probe.yaml. */
  devices: {
    /** Emulator to boot when none is running. */
    avd?: string;
    /** Real phones agents may use. A phone usually carries someone's own accounts. */
    allowReal: string[];
  };
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
  verify: { cards: "approved", maxCards: 10 },
  perf: { maxStartupMs: 4000, maxJankyPct: 15, maxP90Ms: 32 },
  tickets: { pattern: "[A-Z][A-Z0-9]+-\\d+" },
  agents: { model: "sonnet" },
  watch: { enabled: true, drafts: true, maxFeatures: 3 },
  devices: { allowReal: [] },
};

export function configPath(root: string): string {
  return join(root, CONFIG_DIR, CONFIG_FILE);
}

export function loadConfig(root: string, localDir: string): ProbeConfig {
  const file = configPath(root);
  const raw = (existsSync(file) ? parse(readFileSync(file, "utf8")) ?? {} : {}) as Partial<ProbeConfig>;
  const localFile = join(localDir, LOCAL_CONFIG_FILE);
  const local = readLocal(localDir);
  return {
    name: raw.name,
    features: { roots: raw.features?.roots ?? DEFAULTS.features.roots },
    exclude: raw.exclude ?? [],
    unit: { ...DEFAULTS.unit, ...raw.unit },
    app: { ...raw.app },
    verify: { ...DEFAULTS.verify, ...raw.verify },
    perf: { ...DEFAULTS.perf, ...raw.perf },
    tickets: { ...DEFAULTS.tickets, ...raw.tickets },
    // This machine's choice wins over the team's: each developer's plan decides which models they can use.
    agents: { ...DEFAULTS.agents, ...raw.agents, ...local.agents },
    watch: { ...DEFAULTS.watch, ...raw.watch },
    devices: { avd: local.devices?.avd, allowReal: local.devices?.allowReal ?? [] },
  };
}

/** What a machine may set for itself, in `<store>/local.yaml`. */
export type LocalSettings = Partial<Pick<ProbeConfig, "devices" | "agents">>;

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

export function saveLocalDevices(localDir: string, devices: ProbeConfig["devices"]): void {
  saveLocal(localDir, { devices });
}

/** Where the agent model in effect comes from, for Studio. */
export function agentModelSource(root: string, localDir: string): "machine" | "project" | "default" {
  if (readLocal(localDir).agents?.model) return "machine";
  const file = configPath(root);
  const raw = (existsSync(file) ? (parse(readFileSync(file, "utf8")) ?? {}) : {}) as Partial<ProbeConfig>;
  return raw.agents?.model ? "project" : "default";
}

export const CONFIG_TEMPLATE = `# Probe settings for this project. Everything here is optional.
# Shared with the team: commit this folder. Local results live outside the repo.

# name: MyApp

features:
  # Module folders whose next segment is a feature: :feature:chat:impl -> "chat"
  roots: [feature, features]

# Leave features or modules out of scans and runs (prefix match).
exclude: []
#  - universe
#  - :feature:legacy

unit:
  androidTask: testDebugUnitTest
  jvmTask: test

# The app agents test on a device.
app:
  # package: com.example.app.debug
  # installTask: ":app:installDebug"

# Test accounts: add them in Studio -> Accounts (roles and usernames are saved to
# probe/hints/accounts.yaml; passwords stay encrypted on each machine).

# Model for Probe's background agents (any name claude --model accepts).
agents:
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

tickets:
  # pattern: 'PROJ-\\d+'
  # url: https://jira.example.com/browse/{id}
  # fileCommand: gh issue create --title {title} --body-file {file}
`;

export function isExcluded(config: ProbeConfig, featureId: string, moduleId?: string): boolean {
  return config.exclude.some(
    (rule) => featureId === rule || featureId.startsWith(`${rule}:`) || (moduleId?.startsWith(rule) ?? false),
  );
}

/** Shared settings Studio may change. A value of null removes the key. */
export interface ProjectPatch {
  app?: { package?: string | null; installTask?: string | null };
  verify?: { base?: string | null; cards?: "approved" | "all"; maxCards?: number };
  perf?: { maxStartupMs?: number; maxJankyPct?: number; maxP90Ms?: number; maxMemoryMb?: number | null };
  tickets?: { pattern?: string | null; url?: string | null; fileCommand?: string | null };
  agents?: { model?: string | null };
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
    if (!isMap(doc.get(section))) doc.set(section, doc.createNode({}));
    for (const [key, value] of Object.entries(values ?? {})) {
      if (value === undefined) continue;
      if (value === null || value === "") doc.deleteIn([section, key]);
      else doc.setIn([section, key], value);
    }
  }
  writeFileSync(file, doc.toString());
}
