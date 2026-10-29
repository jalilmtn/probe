import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse } from "yaml";
import { isTestPath } from "../../core/testfiles.js";
import { devicesUnsupported, ignoredPathPattern, type ProjectAdapter } from "../adapter.js";
import { type AreaDef, globRegex, listProjectFiles } from "../generic/areas.js";
import { areaModules, GENERIC_IGNORED, unitAndDeviceChecks } from "../generic/index.js";
import { routeHints } from "../generic/modules.js";
import { runCommands } from "../generic/unit.js";

interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

/** One workspace package: its area, folder and manifest. */
interface Workspace {
  area: AreaDef;
  dir: string;
  pkg: PackageJson;
}

/**
 * Node and TypeScript projects (package.json). Workspaces are the areas; a project without
 * them is split by folder like any repo. Unit tests run through the package manager's `test`
 * script, per workspace when each has one; `probe.yaml` overrides either.
 */
export const nodeAdapter: ProjectAdapter = {
  id: "node",
  label: "Node/TypeScript",
  ignoredDirs: [...GENERIC_IGNORED, ".svelte-kit", ".nuxt", ".parcel-cache", ".yarn", ".pnpm-store"],
  supportsDevices: false,

  detect(root) {
    return existsSync(join(root, "package.json"));
  },

  projectName(root) {
    return readPackage(root)?.name ?? basename(root);
  },

  scanModules(root, config) {
    const pm = packageManager(root);
    const rootTest = config.unit.command ?? (hasTestScript(readPackage(root)) ? `${pm} test` : null);
    let spaces: Workspace[] = [];
    return areaModules(root, config, nodeAdapter, {
      fallback: (files) => {
        spaces = workspaces(root, files);
        return spaces.length ? spaces.map((w) => w.area) : null;
      },
      command: (area, hasTests) => {
        if (config.unit.command) return hasTests ? config.unit.command : null;
        const space = spaces.find((w) => w.area === area);
        if (space) return hasTestScript(space.pkg) ? workspaceTest(pm, space) : null;
        return hasTests ? rootTest : null;
      },
    });
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
    return Promise.reject(new Error(devicesUnsupported(nodeAdapter)));
  },

  detectApp() {
    return null;
  },

  moduleDependencies(root) {
    const spaces = workspaces(root, listProjectFiles(root, ignoredPathPattern(nodeAdapter)));
    const idOf = new Map(spaces.map((w) => [w.pkg.name, `:${w.dir.replace(/\//g, ":")}`]));
    return new Map(
      spaces.map((w) => {
        const deps = Object.keys({ ...w.pkg.dependencies, ...w.pkg.devDependencies, ...w.pkg.peerDependencies });
        return [idOf.get(w.pkg.name)!, deps.map((d) => idOf.get(d)).filter((d): d is string => !!d)];
      }),
    );
  },

  isTestSource(relPath) {
    return isTestPath(relPath);
  },

  doctor(root, config) {
    const pkg = readPackage(root);
    const pm = packageManager(root);
    const installed = existsSync(join(root, "node_modules"));
    return [
      {
        id: "node-modules",
        label: "Dependencies",
        status: installed ? "ok" : "warn",
        detail: installed ? `installed (${pm})` : "node_modules missing: tests will not run",
        fix: installed ? undefined : `Run \`${pm} install\``,
      },
      ...unitAndDeviceChecks(config, nodeAdapter, hasTestScript(pkg) ? `${pm} test` : null),
    ];
  },
};

function readPackage(dir: string): PackageJson | null {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as PackageJson;
  } catch {
    return null;
  }
}

/** `npm init` writes a test script that only fails; it is no test suite. */
function hasTestScript(pkg: PackageJson | null): boolean {
  const test = pkg?.scripts?.test;
  return !!test && !/no test specified/.test(test);
}

type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

function packageManager(root: string): PackageManager {
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(root, "yarn.lock"))) return "yarn";
  if (existsSync(join(root, "bun.lockb")) || existsSync(join(root, "bun.lock"))) return "bun";
  return "npm";
}

function workspaceTest(pm: PackageManager, w: Workspace): string {
  const name = w.pkg.name ?? w.dir;
  switch (pm) {
    case "pnpm":
      return `pnpm --filter ${name} test`;
    case "yarn":
      return `yarn workspace ${name} test`;
    case "bun":
      return `bun run --cwd ${w.dir} test`;
    default:
      return `npm test --workspace=${w.dir}`;
  }
}

/** Workspace packages from package.json `workspaces` or pnpm-workspace.yaml, each an area named after its package. */
function workspaces(root: string, files: string[]): Workspace[] {
  const pkg = readPackage(root);
  let globs = Array.isArray(pkg?.workspaces) ? pkg.workspaces : (pkg?.workspaces?.packages ?? []);
  const pnpm = join(root, "pnpm-workspace.yaml");
  if (!globs.length && existsSync(pnpm)) globs = ((parse(readFileSync(pnpm, "utf8")) ?? {}) as { packages?: string[] }).packages ?? [];
  const include = globs.filter((g) => !g.startsWith("!")).map(globRegex);
  const exclude = globs.filter((g) => g.startsWith("!")).map((g) => globRegex(g.slice(1)));
  const dirs = files
    .filter((f) => f.endsWith("/package.json"))
    .map((f) => f.slice(0, -"/package.json".length))
    .filter((d) => include.some((r) => r.test(d)) && !exclude.some((r) => r.test(d)))
    .sort();
  const named = dirs.map((dir) => ({ dir, pkg: readPackage(join(root, dir)) ?? {} }));
  const short = (w: { dir: string; pkg: PackageJson }) => (w.pkg.name ?? basename(w.dir)).replace(/^@[^/]+\//, "");
  const counts = new Map<string, number>();
  for (const w of named) counts.set(short(w), (counts.get(short(w)) ?? 0) + 1);
  return named.map((w) => ({ ...w, area: { id: counts.get(short(w))! > 1 ? (w.pkg.name ?? w.dir) : short(w), group: "feature" as const, dirs: [w.dir] } }));
}
