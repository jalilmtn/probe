import type { ProbeConfig } from "../core/config.js";
import type { DoctorCheck, ModuleInfo, ModuleTestResult } from "../core/types.js";

/**
 * Everything Probe knows about one kind of project (Android/Gradle, Node, any git repo).
 * The engine, MCP server and Studio only ever talk to this interface, never to a build tool.
 */
export interface ProjectAdapter {
  readonly id: string;
  /** What people call this kind of project, for messages: "Android/Gradle". */
  readonly label: string;
  /** Folders (by name, at any depth) that hold build output or tooling state, never anyone's code. */
  readonly ignoredDirs: readonly string[];
  /**
   * Whether agents can run the app on a device (cards, screen mapping, login). Without it the
   * device and app methods below are never called and Studio shows those features as unavailable.
   */
  readonly supportsDevices: boolean;
  detect(root: string): boolean;
  projectName(root: string): string;
  /** Modules with their classes and test inventory. */
  scanModules(root: string, config: ProbeConfig): ModuleInfo[];
  /** Runs the unit tests of the given modules in one build invocation. */
  runUnitTests(root: string, modules: ModuleInfo[], onLine: (line: string) => void, config: ProbeConfig): Promise<UnitInvocation>;
  /**
   * Reads results written at or after `sinceMs`, so a stale report is never passed off as
   * this run's, except for modules the build reused (`invocation.reused`), whose reports
   * are still valid.
   */
  collectUnitResults(root: string, modules: ModuleInfo[], sinceMs: number, invocation: UnitInvocation): ModuleTestResult[];
  /** Source lines that declare screens, routes or deep links, as `file:line: text`. Helps an agent find how to reach a feature. */
  navigationHints(root: string, modules: ModuleInfo[], limit: number): string[];
  /** Builds and installs the app on one device with the given build task. Resolves with the exit code. */
  installApp(root: string, task: string, deviceSerial: string, onLine: (line: string) => void): Promise<number>;
  /** The app this project builds, found without running the build; null when it builds none. */
  detectApp(root: string): DetectedApp | null;
  /** Each module's direct dependencies on other modules of the project (module ids). */
  moduleDependencies(root: string): Map<string, string[]>;
  /** Whether a project-relative path is test code (where an agent writing tests may edit). */
  isTestSource(relPath: string): boolean;
  /** Project-type specific setup checks (SDKs, wrappers, devices). */
  doctor(root: string, config: ProbeConfig): DoctorCheck[];
}

export interface DetectedApp {
  module: string;
  /** Application id agents test; undefined until it is known (e.g. never built and set from secrets). */
  package?: string;
  installTask: string;
  /** Where the package came from. */
  source: "last build" | "build file" | "none";
}

export interface UnitInvocation {
  command: string;
  exitCode: number;
  /** Modules whose tests the build skipped because nothing changed (up to date / from cache). */
  reused: string[];
  /** Results the adapter already read while running (one command per group of modules); `collectUnitResults` returns them. */
  results?: ModuleTestResult[];
}

/** Folders no adapter ever counts as code. */
const ALWAYS_IGNORED = [".git", ".idea", "node_modules"];

/** Matches a project-relative, forward-slash path inside a folder nobody's code lives in. */
export function ignoredPathPattern(adapter: Partial<Pick<ProjectAdapter, "ignoredDirs">>): RegExp {
  const names = [...new Set([...ALWAYS_IGNORED, ...(adapter.ignoredDirs ?? [])])].map((d) => d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(^|/)(${names.join("|")})(/|$)`);
}

/** Why a device feature cannot run on this project. */
export function devicesUnsupported(adapter: Pick<ProjectAdapter, "label">): string {
  return `Device testing is not available for ${adapter.label} projects yet: unit tests, coverage, manifests and cards work, running the app on a device does not.`;
}
