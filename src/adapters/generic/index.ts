import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { configPath, type ProbeConfig } from "../../core/config.js";
import { isTestPath } from "../../core/testfiles.js";
import type { DoctorCheck, ModuleInfo } from "../../core/types.js";
import { devicesUnsupported, ignoredPathPattern, type ProjectAdapter } from "../adapter.js";
import { type AreaDef, configuredAreas, discoverAreas, listProjectFiles } from "./areas.js";
import { buildModules, routeHints } from "./modules.js";
import { runCommands } from "./unit.js";

/** Build output and tool state of the usual languages, never anyone's code. */
export const GENERIC_IGNORED = ["build", "dist", "out", "target", "coverage", "vendor", "__pycache__", ".venv", "venv", ".tox", ".pytest_cache", ".mypy_cache", ".gradle", ".next", ".turbo", ".cache"];

/**
 * Modules of a project Probe has no build tool for: areas from `probe.yaml`, else `fallback`
 * (an adapter's own, such as workspaces), else the folder layout. An area runs its own
 * command from `unit.areas`, else `command` when it has tests.
 */
export function areaModules(
  root: string,
  config: ProbeConfig,
  adapter: Pick<ProjectAdapter, "ignoredDirs">,
  options: { fallback?: (files: string[]) => AreaDef[] | null; command?: (area: AreaDef, hasTests: boolean) => string | null } = {},
): ModuleInfo[] {
  const files = listProjectFiles(root, ignoredPathPattern(adapter));
  const areas = config.areas ? configuredAreas(config.areas, files) : (options.fallback?.(files) ?? discoverAreas(files));
  return buildModules(root, files, areas, (area, hasTests) => config.unit.areas?.[area.id] ?? options.command?.(area, hasTests) ?? (hasTests ? (config.unit.command ?? null) : null));
}

/** The checks every project without device support shares: the unit command and the device note. */
export function unitAndDeviceChecks(config: ProbeConfig, adapter: Pick<ProjectAdapter, "label">, inferred: string | null): DoctorCheck[] {
  const command = config.unit.command ?? inferred;
  return [
    {
      id: "unit-command",
      label: "Unit test command",
      status: command || config.unit.areas ? "ok" : "warn",
      detail: command ? `${command}${config.unit.command ? "" : " (detected)"}` : config.unit.areas ? `per area: ${Object.keys(config.unit.areas).join(", ")}` : "none: unit runs are unavailable",
      fix: command || config.unit.areas ? undefined : "Set unit.command in probe/probe.yaml, e.g. `pytest` or `go test ./...`",
    },
    {
      id: "unit-results",
      label: "Unit results",
      status: "ok",
      detail: config.unit.junit ? `JUnit XML at ${config.unit.junit}` : "from the test runner's summary, else the exit code (set unit.junit for per-test results)",
    },
    { id: "devices", label: "Device testing", status: "warn", detail: devicesUnsupported(adapter) },
  ];
}

/**
 * Any repository: the fallback when no adapter knows the build tool. Areas come from the
 * folder layout or `probe.yaml`, unit tests from `unit.command`; device features are off.
 */
export const genericAdapter: ProjectAdapter = {
  id: "generic",
  label: "generic",
  ignoredDirs: GENERIC_IGNORED,
  supportsDevices: false,

  detect(root) {
    return existsSync(join(root, ".git")) || existsSync(configPath(root));
  },

  projectName(root) {
    return basename(root);
  },

  scanModules(root, config) {
    return areaModules(root, config, genericAdapter);
  },

  runUnitTests(root, modules, onLine, config) {
    return runCommands(root, modules, onLine, config);
  },

  collectUnitResults(_root, _modules, _sinceMs, invocation) {
    return invocation.results ?? [];
  },

  navigationHints(root, modules, limit) {
    return routeHints(root, modules, limit);
  },

  installApp() {
    return Promise.reject(new Error(devicesUnsupported(genericAdapter)));
  },

  detectApp() {
    return null;
  },

  moduleDependencies() {
    // Without a build file there is nothing reliable to read dependencies from.
    return new Map();
  },

  isTestSource(relPath) {
    return isTestPath(relPath);
  },

  doctor(_root, config) {
    return unitAndDeviceChecks(config, genericAdapter, null);
  },
};
