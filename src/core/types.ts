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

/** What every agent-on-device run records, whatever it was asked to do. */
interface DeviceRunFields {
  device: string;
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
  costUsd: number;
}

/** One problem a run found that someone could fix. Its id is `<run id>:<n>`. */
export interface RunIssue {
  id: string;
  runId: string;
  feature: string;
  cardId?: string;
  kind: "test" | "build" | "card" | "expectation" | "crash" | "perf" | "navigation";
  title: string;
  detail: string;
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
  summary?: string;
  costUsd: number;
}

export type Run = UnitRun | BackfillRun | CardRun | LoginRun | ExploreRun | UnitWriteRun | VerifyRun | FixRun;
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
