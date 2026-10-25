import type { ProbeConfig } from "../core/config.js";
import type { DoctorCheck, ModuleInfo, ModuleTestResult } from "../core/types.js";

/**
 * Everything Probe knows about one kind of project (Android/Gradle today; iOS, web later).
 * The engine, MCP server and Studio only ever talk to this interface, never to a build tool.
 */
export interface ProjectAdapter {
  readonly id: string;
  detect(root: string): boolean;
  projectName(root: string): string;
  /** Modules with their classes and test inventory. */
  scanModules(root: string, config: ProbeConfig): ModuleInfo[];
  /** Runs the unit tests of the given modules in one build invocation. */
  runUnitTests(root: string, modules: ModuleInfo[], onLine: (line: string) => void): Promise<UnitInvocation>;
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
  doctor(root: string): DoctorCheck[];
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
}
