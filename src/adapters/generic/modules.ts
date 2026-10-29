import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { KIND_WEIGHT } from "../../core/kinds.js";
import { isTestPath, SOURCE_EXT, stemOf, testedName } from "../../core/testfiles.js";
import type { ClassInfo, ClassKind, ModuleInfo, TestLink } from "../../core/types.js";
import type { AreaDef } from "./areas.js";

/**
 * Turns areas into modules, one per folder of an area. Without a compiler to ask, the unit
 * Probe inventories is the source file: a test covers a file directly when it is named after
 * it (`jobs.test.ts` → `jobs.ts`) and references it when it imports it. Tests in a folder of
 * their own (`test/`, `tests/`) count for every area they import.
 */
export function buildModules(root: string, files: string[], areas: AreaDef[], unitCommand: (area: AreaDef, hasTests: boolean) => string | null): ModuleInfo[] {
  const byDir = new Map<string, { area: AreaDef; sources: string[]; tests: Set<string> }>();
  for (const area of areas) for (const dir of area.dirs) if (!byDir.has(dir)) byDir.set(dir, { area, sources: [], tests: new Set() });

  const ownerOf = (file: string) => {
    let dir = file;
    while (dir.includes("/")) {
      dir = dir.slice(0, dir.lastIndexOf("/"));
      const owner = byDir.get(dir);
      if (owner) return dir;
    }
    return undefined;
  };

  const code = files.filter((f) => SOURCE_EXT.test(f));
  const orphanTests: string[] = [];
  for (const file of code) {
    const owner = ownerOf(file);
    const test = isTestPath(file);
    if (owner) {
      if (test) byDir.get(owner)!.tests.add(file);
      else byDir.get(owner)!.sources.push(file);
    } else if (test) orphanTests.push(file);
  }

  const sourcesBySansExt = new Map<string, string>();
  for (const m of byDir.values()) for (const f of m.sources) sourcesBySansExt.set(f.replace(/\.[^./]+$/, ""), f);

  // What each test touches: the files it imports, and the files it is named after.
  const direct = new Set<string>();
  const referenced = new Set<string>();
  const readTest = (test: string, scope: Set<string> | null): Set<string> => {
    const text = safeRead(join(root, test));
    const imported = resolveImports(test, text, sourcesBySansExt);
    for (const f of imported) referenced.add(f);
    const dirsTouched = scope ?? new Set([...imported].map((f) => ownerOf(f)!).filter(Boolean));
    const name = normal(testedName(posix.basename(test)));
    const named = [...dirsTouched].flatMap((d) => byDir.get(d)!.sources.filter((s) => normal(stemOf(posix.basename(s))) === name));
    for (const f of named) direct.add(f);
    return dirsTouched;
  };
  for (const [dir, m] of byDir) for (const test of m.tests) readTest(test, new Set([dir]));
  for (const test of orphanTests) {
    let touched = readTest(test, null);
    if (touched.size === 0) {
      // No import Probe can follow: fall back to the name alone.
      const name = normal(testedName(posix.basename(test)));
      touched = new Set([...byDir].filter(([, m]) => m.sources.some((s) => normal(stemOf(posix.basename(s))) === name)).map(([d]) => d));
      readTest(test, touched);
    }
    for (const d of touched) byDir.get(d)!.tests.add(test);
  }

  return [...byDir].map(([dir, m]): ModuleInfo => {
    const sourcesOwned = m.sources;
    const classes = sourcesOwned.map((file) => fileUnit(root, file, direct.has(file) ? "direct" : referenced.has(file) ? "referenced" : "none"));
    const command = unitCommand(m.area, m.tests.size > 0);
    return {
      id: `:${dir.replace(/\//g, ":")}`,
      dir: join(root, dir),
      platform: "unknown",
      mainFiles: sourcesOwned.length,
      testFiles: m.tests.size,
      instrumentedTestFiles: 0,
      unitTestTask: command,
      classes,
      feature: { id: m.area.id, group: m.area.group },
    };
  });
}

/** `../src/engine/runs.js`, `./store`, `from pkg.engine import x`: the project files a test imports. */
function resolveImports(file: string, text: string, sources: Map<string, string>): Set<string> {
  const out = new Set<string>();
  const dir = posix.dirname(file);
  const lookup = (path: string) => sources.get(path) ?? sources.get(`${path}/index`) ?? sources.get(`${path}/__init__`);
  for (const m of text.matchAll(/(?:\bfrom\s+|\bimport\s*\(?\s*|\brequire\(\s*)["'](\.{1,2}\/[^"']+)["']/g)) {
    const found = lookup(posix.normalize(posix.join(dir, m[1]!)).replace(/\.(m?[jt]sx?|c[jt]s)$/, ""));
    if (found) out.add(found);
  }
  if (file.endsWith(".py")) {
    for (const m of text.matchAll(/^\s*(?:from|import)\s+([\w.]+)/gm)) {
      const path = m[1]!.replace(/\./g, "/");
      const found = lookup(path) ?? [...sources.keys()].filter((k) => k.endsWith(`/${path}`)).map((k) => sources.get(k)!)[0];
      if (found) out.add(found);
    }
  }
  return out;
}

function fileUnit(root: string, file: string, test: TestLink): ClassInfo {
  const base = posix.basename(file);
  const stem = stemOf(base);
  const generic = /^(index|main|mod|__init__|lib)$/.test(stem);
  const name = generic ? `${posix.basename(posix.dirname(file))}/${stem}` : stem;
  const lines = Math.max(1, safeRead(join(root, file)).split("\n").length);
  const kind = classifyFile(stem, base);
  return { name, file, kind, lines, test, risk: Math.round(KIND_WEIGHT[kind] * Math.log2(lines + 1) * 10) / 10 };
}

/** What a file is, judged by its name: how much it is worth unit-testing follows from it. */
export function classifyFile(stem: string, fileName: string): ClassKind {
  if (/\.d$/.test(stem) || /^(types?|constants?|consts?|models?|schemas?|dtos?|enums?)$/i.test(stem) || /(Types?|Model|Dto|DTO|Schema|Entity|Enum|Constants)$/.test(stem)) return "model";
  if (/reducer$/i.test(stem)) return "reducer";
  if (/use-?case$/i.test(stem)) return "usecase";
  if (/view-?model$/i.test(stem)) return "viewmodel";
  if (/(repository|repo|dao|data-?source|store)$/i.test(stem)) return "repository";
  if (/(mapper|converter|serializer|parser|formatter)$/i.test(stem)) return "mapper";
  if (/\.(tsx|jsx|vue|svelte)$/.test(fileName) || /(component|view|page|screen|widget|layout)$/i.test(stem)) return "ui";
  if (/(service|manager|handler|controller|engine|client|runner|scheduler|worker|validator|resolver|utils?|helpers?)$/i.test(stem)) return "logic";
  return "other";
}

function normal(name: string): string {
  return name.toLowerCase().replace(/[-_.]/g, "");
}

function safeRead(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** Route, page and deep-link declarations in common web and server frameworks, as `file:line: text`. */
export function routeHints(root: string, modules: ModuleInfo[], limit: number): string[] {
  const out: string[] = [];
  for (const m of modules) {
    for (const c of m.classes) {
      if (out.length >= limit) return out;
      safeRead(join(root, c.file))
        .split(/\r?\n/)
        .forEach((text, i) => {
          if (out.length < limit && ROUTE_HINT.test(text)) out.push(`${c.file}:${i + 1}: ${text.trim().slice(0, 160)}`);
        });
    }
  }
  return out;
}

const ROUTE_HINT =
  /<Route\b|createBrowserRouter|\bpath:\s*["'`]\/|\b(app|router|server)\.(get|post|put|patch|delete|use|route)\(\s*["'`]\/|@(Get|Post|Put|Patch|Delete|Request)Mapping|@app\.(get|post|route)\(|\burlpatterns\b|\bpath\(\s*["']|HandleFunc\(\s*["']\/|\bdefineRoutes?\b/;
