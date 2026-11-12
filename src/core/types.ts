// Shared data model. Everything Probe produces (scans, runs, later cards and findings)
// is one of these shapes, so adapters, the MCP server and Studio never invent their own.

export type ClassKind =
  | "reducer"
  | "usecase"
  | "viewmodel"
  | "repository"
  | "mapper"
  | "logic"
  | "other"
  | "ui"
  | "model"
  | "di"
  | "interface";

/** How a production class is covered by unit tests, judged statically. */
export type TestLink = "direct" | "referenced" | "none";

export interface ClassInfo {
  name: string;
  /** Path relative to the project root, forward slashes. */
  file: string;
  kind: ClassKind;
  lines: number;
  test: TestLink;
  /** Higher = more worth testing. 0 for things nobody unit-tests (DI, interfaces). */
  risk: number;
}

export interface ModuleInfo {
  /** Build-system id, e.g. ":feature:chat:impl". */
  id: string;
  dir: string;
  platform: "android" | "jvm" | "unknown";
  mainFiles: number;
  testFiles: number;
  instrumentedTestFiles: number;
  /** Task/command that runs this module's unit tests, or null when it has none. */
  unitTestTask: string | null;
  classes: ClassInfo[];
  /**
   * The area this module belongs to, when the adapter decides it (folders, probe.yaml areas,
   * workspaces). Unset: derived from the module id and `features.roots` (Gradle paths).
   */
  feature?: { id: string; group: "feature" | "platform" };
}

export interface FeatureStats {
  modules: number;
  classes: number;
  testable: number;
  direct: number;
  referenced: number;
  untested: number;
  testFiles: number;
}

export interface FeatureInfo {
  id: string;
  group: "feature" | "platform";
  modules: ModuleInfo[];
  stats: FeatureStats;
}

export interface ProjectInfo {
  root: string;
  name: string;
  adapter: string;
  /** Whether agents can run this project's app on a device; absent in scans from before it was recorded (they could). */
  devices?: boolean;
}

export interface ScanResult {
  project: ProjectInfo;
  scannedAt: string;
  features: FeatureInfo[];
  excluded: string[];
}

export interface TestCaseResult {
  name: string;
  className: string;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  message?: string;
}

export interface ModuleTestResult {
  module: string;
  tests: number;
  failed: number;
  skipped: number;
  durationMs: number;
  failures: TestCaseResult[];
  /** Results reused from the last build because the code did not change. */
  cached?: boolean;
}

/**
 * `blocked`: the run could not get far enough to judge (login code, unknown account, no app).
 * `stopped`: a person stopped it; it says nothing about the code and never counts toward health.
 */
export type RunStatus = "running" | "passed" | "failed" | "blocked" | "error" | "stopped";

interface BaseRun {
  id: string;
  /** Feature id, or "*" for a run over every feature. */
  feature: string;
  startedAt: string;
  finishedAt?: string;
  status: RunStatus;
  error?: string;
  /** The code this run tested: branch, commit and uncommitted files when it started. */
  git?: { branch: string | null; commit: string; dirty: number };
}

export interface UnitRun extends BaseRun {
  kind: "unit";
  command: string;
  results: ModuleTestResult[];
}

export interface BackfillRun extends BaseRun {
  kind: "backfill";
  /** Ticket the cards were drafted from, when a ticket started it. */
  ticket?: string;
  /** Card ids written per feature, and reviewed cards left alone. */
  written: string[];
  kept: string[];
  costUsd: number;
}

export interface ExpectationResult {
  text: string;
  /** null = could not be checked. */
  met: boolean | null;
  evidence: string;
}

export interface CardVerdict {
  result: "passed" | "failed" | "blocked";
  expectations: ExpectationResult[];
  notes: string;
  /** Blocked because a test account could not sign in: the next cards would fail the same way. */
  blockedBy?: "sign-in";
}

export interface TimelineEntry {
  at: string;
  action: string;
  detail: string;
  /** Screenshot file name inside the run's evidence folder. */
  screenshot?: string;
}

/**
 * How smooth and heavy the app was during a device run, from Android's own counters
 * (`dumpsys gfxinfo` / `meminfo`, `am start -W`). Frame times cover every transition,
 * animation and scroll the agent caused.
 */
export interface PerfReport {
  /** Cold start to first frame, when the run launched the app itself. */
  startupMs?: number;
  frames: number;
  jankyPct: number;
  p50Ms: number;
  p90Ms: number;
  p99Ms: number;
  /** Total PSS at the end of the run. */
  memoryMb?: number;
  /** Thresholds from probe.yaml this run went over. A warning, never a failure on its own. */
  issues: string[];
}

/** What an agent drives: the Android app on an emulator or phone, or the web app in a browser. */
export type RunTarget = "android" | "web";

/** Where a finished build comes from, when a run tests one instead of the working tree. */
export type BuildSource = "file" | "firebase" | "play";

/** The build a run was asked to test. */
export interface BuildRef {
  source: BuildSource;
  /** `file`: the .apk or .aab path. `firebase` and `play`: a build number or version; empty means the newest. */
  value?: string;
}

/** The build a run did test, as found: which one, and where it came from. */
export interface TestedBuild {
  source: BuildSource;
  /** One line a person recognises it by: "Firebase 1.4.2 (142)". */
  label: string;
  versionCode?: string;
  versionName?: string;
  package?: string;
}

/** What every agent-on-device run records, whatever it was asked to do. */
interface DeviceRunFields {
  device: string;
  /** Absent on runs from before web testing: those were Android. */
  target?: RunTarget;
  /** The finished build the run tested; absent when it tested the working tree. */
  build?: TestedBuild;
  /** Web runs: uncaught page errors, console errors and failed requests seen during the run. */
  webErrors?: string[];
  crashes: string[];
  timeline: TimelineEntry[];
  /** Screen recording file name inside the evidence folder, when one was captured. */
  video?: string;
  perf?: PerfReport;
  costUsd: number;
}

export interface CardRun extends BaseRun, DeviceRunFields {
  kind: "card";
  cardId: string;
  verdict?: CardVerdict;
  /** Set when this run was part of a verify run. */
  parent?: string;
}

/** Which account the app on a device is logged in with, as seen by an agent. */
export interface LoginState {
  state: "logged_in" | "logged_out" | "unknown";
  /** Test account role, or null when logged in with an account that is not a test account. */
  role: string | null;
  /** What the app showed as the user (name or handle), never a password. */
  seenAs?: string;
  notes: string;
}

export interface LoginRun extends BaseRun, DeviceRunFields {
  kind: "login";
  /** The role the agent was asked to log in with; absent for a check only. */
  wanted?: string;
  login?: LoginState;
}

/** One screen an explore run reached, and how. */
export interface NavScreen {
  name: string;
  reach: string[];
  /** Screenshot file in that run's evidence folder. */
  screenshot?: string;
  notes?: string;
}

export interface ExploreRun extends BaseRun, DeviceRunFields {
  kind: "explore";
  screens: NavScreen[];
  /** Problems the agent saw: broken navigation, dead ends, error states, visual glitches. */
  issues: string[];
}

export interface UnitWriteRun extends BaseRun {
  kind: "unitwrite";
  /** Classes the agent was asked to cover. */
  targets: string[];
  /** Files the run created or changed, from git status (relative paths). */
  files: string[];
  /** Changed files outside test source sets: listed for review, never reverted by Probe. */
  outsideTests: string[];
  /** The unit run made after writing, which decides the status. */
  unitRun?: string;
  costUsd: number;
}

/** One affected feature inside a verify run. */
export interface VerifyFeature {
  feature: string;
  /** Changed files that belong to this feature. */
  files: string[];
  unitRun?: string;
  unitStatus?: RunStatus;
  cards: { cardId: string; runId?: string; status: RunStatus | "skipped"; note?: string }[];
}

/** Checks a change: the features its files touch, their unit tests, then their cards on a device. */
export interface VerifyRun extends BaseRun {
  kind: "verify";
  base: string;
  /** Changed files (committed since base, plus uncommitted and untracked). */
  changed: string[];
  /** Changed files no module owns (build scripts, docs, CI). */
  unowned: string[];
  features: VerifyFeature[];
  device: boolean;
  /** The ticket this verify was for. */
  ticket?: string;
  target?: RunTarget;
  /** The finished build its cards ran on; absent when they ran on the working tree. */
  build?: TestedBuild;
  costUsd: number;
}

/** One problem a run found that someone could fix. Its id is `<run id>:<n>`. */
export interface RunIssue {
  id: string;
  runId: string;
  feature: string;
  cardId?: string;
  kind: "test" | "build" | "card" | "expectation" | "crash" | "perf" | "navigation" | "security";
  title: string;
  detail: string;
  /** The finding behind a security issue. */
  security?: SecurityFinding;
}

// ── Security ──────────────────────────────────────────────────────────────────
// Checks from the catalog in docs/security, run in layers. A finding is one check failing at
// one place; its fingerprint survives line moves, so a dismissal sticks.

export type Severity = "critical" | "high" | "medium" | "low" | "info";

/**
 * How a finding was found: rules over source and config, dependency versions against OSV,
 * git history, the built app, the running app (device or localhost), or an agent reading code.
 */
export type SecurityLayer = "static" | "deps" | "history" | "artifact" | "runtime" | "agent";

export interface SecurityFinding {
  /** Catalog id, e.g. AND-WEB-07. */
  check: string;
  title: string;
  severity: Severity;
  layer: SecurityLayer;
  /** Relative path, forward slashes; absent for a finding about the running app as a whole. */
  file?: string;
  line?: number;
  /** The matched code, the vulnerable package, or what the running app showed. Secrets are masked. */
  evidence: string;
  /** Why it matters: the attack path in a sentence or two. */
  why: string;
  fix: string;
  refs: string[];
  feature: string;
  /** Stable across line moves: check + file + normalised evidence. */
  fingerprint: string;
}

export interface SecurityDismissal {
  fingerprint: string;
  check: string;
  file?: string;
  reason: string;
  at: string;
}

/** Security checks over the project, or one feature of it. */
export interface SecurityRun extends BaseRun {
  kind: "security";
  /** Platforms detected, which decide the catalogs that ran (android, ios, web, node…). */
  platforms: string[];
  layers: { layer: SecurityLayer; status: "ran" | "skipped" | "error"; note?: string }[];
  /** Open findings, most severe first. Dismissed ones are counted, not listed. */
  findings: SecurityFinding[];
  dismissed: number;
  /** Files the static layer read. */
  files: number;
  costUsd: number;
}

/** An agent fixes one issue in the code; Probe then checks it (unit tests, the card again). */
export interface FixRun extends BaseRun {
  kind: "fix";
  issue: RunIssue;
  /** Files the agent changed, uncommitted, for review. */
  files: string[];
  unitRun?: string;
  /** The card run again after the fix, for a problem seen on a device. */
  recheckRun?: string;
  /** For a security issue: whether the same check still finds it after the fix. */
  securityRecheck?: { stillFound: boolean; note: string };
  summary?: string;
  costUsd: number;
}

/** One feature inside a check: what an edit touched and what the check found. */
export interface CheckFeature {
  feature: string;
  files: string[];
  /** False when the feature only depends on the changed code (its manifest's `related`, or the module graph). */
  owned: boolean;
  /** Edited platform areas it depends on, when the module graph is what reached it. */
  dependsOn?: string[];
  unitRun?: string;
  unitStatus?: RunStatus | "skipped";
  /** "Class.test: message" for the first failing tests. */
  failures: string[];
  manifest?: { links: number; broken: number; gaps: number; errors: number };
  /** A drafted correction to the manifest or brief, waiting for review. */
  draftId?: string;
  /** Rules only a device card proves, whose cards have no up-to-date pass: "feature/rule (why)". */
  deviceRules?: string[];
  note?: string;
}

/** Runs after code changes: unit tests, manifest links and drafted corrections for the features touched. */
export interface CheckRun extends BaseRun {
  kind: "check";
  /** What caused this check: an agent, commit, editor, or a person pressing Check. */
  trigger: "claude" | "agent" | "commit" | "editor" | "manual";
  features: CheckFeature[];
  /** Stale features left for later: over watch.maxFeatures. */
  skipped: string[];
  costUsd: number;
}

/** One step of `probe init` as a run saw it. */
export interface InitStepState {
  id: string;
  label: string;
  /** done: nothing left; todo: Probe can do it; waiting: a person has to (choose, review); warn: worth a look, blocks nothing. */
  status: "done" | "todo" | "waiting" | "warn";
  detail: string;
}

/** Sets a project up for Probe: config, the agents, the feature manifests and their cards, the agent file. */
export interface InitRun extends BaseRun {
  kind: "init";
  /** The step asked for, or every step in order. */
  only?: string;
  steps: InitStepState[];
  /** Drafts this run made, waiting for review. */
  drafts: string[];
  costUsd: number;
}

/** One step of the workbench for one ticket. */
export interface WorkStepState {
  step: import("./config.js").WorkStep;
  status: RunStatus | "queued" | "skipped";
  note?: string;
  /** The run this step started (unit tests, verify). */
  runId?: string;
}

/** One ticket inside a workbench run. */
export interface WorkTicket {
  key: string;
  source?: string;
  /** The developer's own instructions for this ticket. */
  notes?: string;
  title: string;
  status: RunStatus | "queued" | "needs-you";
  steps: WorkStepState[];
  /** Files changed for this ticket. */
  files: string[];
  /** The commit made for it, when the commit step ran. */
  commit?: { hash: string; message: string };
  /** What the agent said it did. */
  summary?: string;
}

/** The workbench: an agent works through chosen tickets one by one, each with the chosen steps. */
export interface WorkRun extends BaseRun {
  kind: "work";
  tickets: WorkTicket[];
  steps: import("./config.js").WorkStep[];
  commitPattern: string;
  /** The developer's instructions for every ticket of the run. */
  notes?: string;
  costUsd: number;
}

export type Run = UnitRun | BackfillRun | CardRun | LoginRun | ExploreRun | UnitWriteRun | VerifyRun | FixRun | CheckRun | InitRun | SecurityRun | WorkRun;
export type DeviceRun = CardRun | LoginRun | ExploreRun;

// ── Feature cards ─────────────────────────────────────────────────────────────
// A card is what Probe knows about one user-visible behaviour: how to reach it and what
// must be true. Agents test from cards; the Atlas counts them. Shape is enforced by
// `src/cards/schema.ts`; these are the stored types.

export type CardLevel = "feature" | "capability" | "regression";
export type CardConfidence = "high" | "medium" | "low";
export type CardStatus = "draft" | "approved" | "rejected";
export type CheckKind = "ui" | "log" | "network" | "state" | "manual";
export type SourceKind = "code" | "doc" | "commit" | "test" | "device";

export interface CardExpectation {
  text: string;
  check: CheckKind;
}

export interface CardSource {
  type: SourceKind;
  ref: string;
  note?: string;
}

export interface Card {
  id: string;
  feature: string;
  level: CardLevel;
  title: string;
  summary: string;
  reach: string[];
  preconditions: string[];
  steps: string[];
  expect: CardExpectation[];
  accounts: number;
  modules: string[];
  tickets: string[];
  sources: CardSource[];
  confidence: CardConfidence;
  status: CardStatus;
  createdBy: "backfill" | "capture" | "human";
  updatedAt: string;
}

export type CheckStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}
