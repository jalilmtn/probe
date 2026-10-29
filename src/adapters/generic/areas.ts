import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { isTestPath, SOURCE_EXT, TEST_ONLY_DIRS } from "../../core/testfiles.js";

/** One area of a project without a build tool Probe knows: a name and the folders that make it up. */
export interface AreaDef {
  id: string;
  group: "feature" | "platform";
  /** Project-relative folders, forward slashes. */
  dirs: string[];
}

/** Folders that hold a project's parts rather than being one: each folder inside is its own area. */
export const CONTAINER_DIRS = new Set(["src", "lib", "libs", "packages", "apps", "modules", "services", "pkg", "internal", "cmd", "components", "crates", "plugins", "features"]);

/**
 * Every file of the project as a relative forward-slash path: what git tracks plus untracked
 * files it does not ignore, so `.gitignore` keeps build output out. Without git, a plain walk.
 */
export function listProjectFiles(root: string, ignored: RegExp): string[] {
  const git = spawnSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 256 * 1024 * 1024, timeout: 60_000 });
  const listed = !git.error && git.status === 0 ? git.stdout.split("\n").map((l) => l.trim()).filter(Boolean) : walk(root, ignored);
  return listed.filter((f) => !ignored.test(f) && !f.startsWith("probe/"));
}

function walk(root: string, ignored: RegExp): string[] {
  const out: string[] = [];
  const visit = (rel: string) => {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (ignored.test(path)) continue;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) out.push(path);
    }
  };
  visit("");
  return out;
}

/**
 * Areas found from the folder layout: each top-level folder with source code, except the
 * folders inside a container (`src/`, `packages/`, ...) which are areas of their own. Test-only
 * folders never are: their tests are attached to the areas they import.
 */
export function discoverAreas(files: string[]): AreaDef[] {
  const areas = new Map<string, AreaDef>();
  const add = (id: string, group: AreaDef["group"], dir: string) => {
    const area = areas.get(id) ?? { id, group, dirs: [] };
    if (!area.dirs.includes(dir)) area.dirs.push(dir);
    areas.set(id, area);
  };
  for (const file of files) {
    if (!SOURCE_EXT.test(file) || isTestPath(file)) continue;
    const parts = file.split("/");
    if (parts.length < 2) continue;
    const top = parts[0]!;
    if (top.startsWith(".") || TEST_ONLY_DIRS.has(top)) continue;
    if (CONTAINER_DIRS.has(top) && parts.length >= 3 && !TEST_ONLY_DIRS.has(parts[1]!)) add(parts[1]!, "feature", `${top}/${parts[1]}`);
    else add(top, "platform", top);
  }
  return [...areas.values()];
}

/**
 * Areas from `probe.yaml`: a list of globs makes each matching folder an area (named by its
 * last segment, or its whole path when two share one); a map names each area's globs.
 */
export function configuredAreas(spec: string[] | Record<string, string | string[]>, files: string[]): AreaDef[] {
  const dirs = allDirs(files);
  if (Array.isArray(spec)) {
    const matched = [...new Set(spec.flatMap((g) => dirs.filter((d) => globRegex(g).test(d))))].sort();
    const last = (d: string) => d.slice(d.lastIndexOf("/") + 1);
    const taken = new Map<string, number>();
    for (const d of matched) taken.set(last(d), (taken.get(last(d)) ?? 0) + 1);
    return matched.map((d) => ({ id: taken.get(last(d))! > 1 ? d : last(d), group: "feature", dirs: [d] }));
  }
  return Object.entries(spec).map(([id, globs]) => {
    const patterns = (Array.isArray(globs) ? globs : [globs]).map(globRegex);
    // The outermost matching folders: a match inside one already taken adds nothing.
    const matched = dirs.filter((d) => patterns.some((p) => p.test(d))).sort();
    return { id, group: "feature" as const, dirs: matched.filter((d, i) => !matched.slice(0, i).some((o) => d.startsWith(`${o}/`))) };
  });
}

function allDirs(files: string[]): string[] {
  const dirs = new Set<string>();
  for (const f of files) {
    let i = f.indexOf("/");
    while (i > 0) {
      dirs.add(f.slice(0, i));
      i = f.indexOf("/", i + 1);
    }
  }
  return [...dirs];
}

/** `*` within one folder name, `**` across folders, `?` one character; a trailing slash is ignored. */
export function globRegex(glob: string): RegExp {
  const g = glob.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  let out = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === "*" && g[i + 1] === "*") {
      out += ".*";
      i++;
      if (g[i + 1] === "/") i++;
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}
