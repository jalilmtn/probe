// Features across every adapter. Adapters say what the modules are; this decides which feature
// each class belongs to when a module holds several, from `features.map` (globs) or
// `features.packages` (namespaces), so a Gradle, Node or plain-folder project is mapped the same way.
import { globRegex } from "../adapters/generic/areas.js";
import type { ProbeConfig } from "./config.js";
import type { ClassInfo, ModuleInfo } from "./types.js";

/** Folders that hold code without naming anything: skipped when reading a namespace from a path. */
const SOURCE_ROOTS = new Set(["src", "lib", "source", "sources"]);

/**
 * The namespace a file sits in, dotted. JVM sources: the package, from the folders under
 * `kotlin/` or `java/` (`shared/src/commonMain/kotlin/app/daywise/money/X.kt` → `app.daywise.money`).
 * Anything else: its folders, without source roots (`packages/web/src/billing/x.ts` → `packages.web.billing`).
 */
export function namespaceOf(file: string): string {
  const jvm = /\/src\/[^/]+\/(?:kotlin|java)\/(.+)\/[^/]+$/.exec("/" + file);
  if (jvm) return jvm[1]!.replace(/\//g, ".");
  return file
    .split("/")
    .slice(0, -1)
    .filter((d) => !SOURCE_ROOTS.has(d))
    .join(".");
}

/** Picks a feature for a class from `features.map`: the first entry with a glob matching the file or a folder it sits in. */
function byMap(map: Record<string, string | string[]>): (c: ClassInfo) => string | null {
  const entries = Object.entries(map).map(([id, globs]) => ({ id, patterns: (Array.isArray(globs) ? globs : [globs]).map(globRegex) }));
  return (c) => {
    const paths = c.file.split("/").map((_, i, parts) => parts.slice(0, i + 1).join("/"));
    return entries.find((e) => e.patterns.some((p) => paths.some((path) => p.test(path))))?.id ?? null;
  };
}

/** Picks a feature from `features.packages`: the namespace segment after the longest matching prefix. */
function byPackage(prefixes: string[]): (c: ClassInfo) => string | null {
  const sorted = [...prefixes].sort((a, b) => b.length - a.length);
  return (c) => {
    const ns = namespaceOf(c.file);
    const prefix = sorted.find((p) => ns.startsWith(p + "."));
    return prefix ? ns.slice(prefix.length + 1).split(".")[0]! : null;
  };
}

/**
 * One entry per feature the module's classes fall into; classes no rule places stay with the
 * module as it was. Each entry keeps the module's id, tests and unit task: tests run per module.
 */
export function splitModule(module: ModuleInfo, pick: (c: ClassInfo) => string | null): ModuleInfo[] {
  const byFeature = new Map<string, ClassInfo[]>();
  const rest: ClassInfo[] = [];
  for (const c of module.classes) {
    const feature = pick(c);
    if (feature) byFeature.set(feature, [...(byFeature.get(feature) ?? []), c]);
    else rest.push(c);
  }
  if (byFeature.size === 0) return [module];
  const files = (cs: ClassInfo[]) => new Set(cs.map((c) => c.file)).size;
  const out: ModuleInfo[] = [...byFeature.entries()].map(([feature, classes]) => ({
    ...module,
    classes,
    mainFiles: files(classes),
    feature: { id: feature, group: "feature" },
  }));
  if (rest.length > 0) out.push({ ...module, classes: rest, mainFiles: files(rest) });
  return out;
}

/** The modules an adapter found, split by `features.map`, else `features.packages`; unchanged when neither is set. */
export function assignFeatures(modules: ModuleInfo[], features: ProbeConfig["features"]): ModuleInfo[] {
  const { map, packages } = features;
  const pick = map && Object.keys(map).length > 0 ? byMap(map) : packages?.length ? byPackage(packages) : null;
  return pick ? modules.flatMap((m) => splitModule(m, pick)) : modules;
}

/** Each module once: a module split into features appears once per feature, and its tests run once. */
export function uniqueModules(modules: ModuleInfo[]): ModuleInfo[] {
  return modules.filter((m, i) => modules.findIndex((o) => o.id === m.id) === i);
}
