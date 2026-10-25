import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { IncludedModule } from "./settings.js";

/** `share-with` / `share_with` → `shareWith`, as Gradle's type-safe project accessors name it. */
function accessorSegment(segment: string): string {
  return segment.replace(/[-_]+([a-zA-Z0-9])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Direct module dependencies from each build file: `project(":a:b")` and type-safe
 * `projects.a.b` accessors. Dependencies a convention plugin adds are not visible here, which
 * only makes Probe call fewer results "maybe outdated", never more.
 */
export function moduleDependencies(modules: IncludedModule[]): Map<string, string[]> {
  const byAccessor = new Map(modules.map((m) => [`projects.${m.id.slice(1).split(":").map(accessorSegment).join(".")}`, m.id]));
  const ids = new Set(modules.map((m) => m.id));
  const out = new Map<string, string[]>();
  for (const m of modules) {
    const file = ["build.gradle.kts", "build.gradle"].map((f) => join(m.dir, f)).find(existsSync);
    if (!file) continue;
    const text = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const deps = new Set<string>();
    for (const x of text.matchAll(/project\(\s*(?:path\s*=\s*)?["'](:[^"']+)["']/g)) if (ids.has(x[1]!)) deps.add(x[1]!);
    for (const x of text.matchAll(/\bprojects(?:\.[A-Za-z_][\w]*)+/g)) {
      // Longest accessor that names a module: `projects.core.mapper.dependencyProject` is still :core:mapper.
      let ref = x[0];
      while (ref.includes(".") && !byAccessor.has(ref)) ref = ref.slice(0, ref.lastIndexOf("."));
      const id = byAccessor.get(ref);
      if (id) deps.add(id);
    }
    deps.delete(m.id);
    out.set(m.id, [...deps].sort());
  }
  return out;
}
