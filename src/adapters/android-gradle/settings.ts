import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const SETTINGS_FILES = ["settings.gradle.kts", "settings.gradle"];

export function settingsFile(root: string): string | null {
  const name = SETTINGS_FILES.find((f) => existsSync(join(root, f)));
  return name ? join(root, name) : null;
}

export interface IncludedModule {
  id: string;
  dir: string;
}

/**
 * Reads `include(...)` entries (Kotlin and Groovy DSL, one or many per call) and any
 * `project(":x").projectDir = file("...")` overrides. Entries without a build file are
 * container folders, not modules, and are dropped.
 */
export function includedModules(root: string): IncludedModule[] {
  const file = settingsFile(root);
  if (!file) return [];
  const text = stripComments(readFileSync(file, "utf8"));

  const overrides = new Map<string, string>();
  for (const m of text.matchAll(/project\(\s*["'](:[^"']+)["']\s*\)\.projectDir\s*=\s*(?:file\()?\s*["']([^"']+)["']/g)) {
    overrides.set(m[1]!, m[2]!);
  }

  const ids = new Set<string>();
  for (const call of text.matchAll(/^\s*include\s*\(?([^\n]*)/gm)) {
    for (const s of call[1]!.matchAll(/["']([^"']+)["']/g)) {
      const raw = s[1]!;
      ids.add(raw.startsWith(":") ? raw : `:${raw}`);
    }
  }

  return [...ids]
    .map((id) => ({ id, dir: join(root, overrides.get(id) ?? id.slice(1).split(":").join("/")) }))
    .filter((m) => existsSync(join(m.dir, "build.gradle.kts")) || existsSync(join(m.dir, "build.gradle")));
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}
