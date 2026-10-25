import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DetectedApp } from "../adapter.js";
import { includedModules } from "./settings.js";

const APPLICATION_PLUGIN = /com\.android\.application|android[.-]application|androidApplication/;

function buildFileOf(dir: string): string | null {
  for (const name of ["build.gradle.kts", "build.gradle"]) if (existsSync(join(dir, name))) return readFileSync(join(dir, name), "utf8");
  return null;
}

/**
 * Finds the app the project builds, without running Gradle: the module that applies an
 * Android application plugin (directly or through a convention plugin whose id says so),
 * its debug install task, and its application id. The id is read from the last debug build
 * (`output-metadata.json`, exact: suffixes and ids from secrets included) and, failing that,
 * from the build file; it can be unknown until the app has been built once.
 */
export function detectAndroidApp(root: string): DetectedApp | null {
  const apps = includedModules(root)
    .map((m) => ({ ...m, build: buildFileOf(m.dir) }))
    .filter((m) => m.build && APPLICATION_PLUGIN.test(m.build));
  if (apps.length === 0) return null;
  const app = apps.find((m) => m.id === ":app") ?? apps[0]!;

  // A flavoured app builds apk/<flavor>/debug; plain apps build apk/debug.
  const apkDir = join(app.dir, "build", "outputs", "apk");
  let flavor = "";
  let metadata: string | null = existsSync(join(apkDir, "debug", "output-metadata.json")) ? join(apkDir, "debug", "output-metadata.json") : null;
  if (!metadata && existsSync(apkDir)) {
    for (const d of readdirSync(apkDir)) {
      const file = join(apkDir, d, "debug", "output-metadata.json");
      if (existsSync(file)) {
        flavor = d;
        metadata = file;
        break;
      }
    }
  }
  const installTask = `${app.id}:install${flavor ? flavor[0]!.toUpperCase() + flavor.slice(1) : ""}Debug`;

  if (metadata) {
    const id = (JSON.parse(readFileSync(metadata, "utf8")) as { applicationId?: string }).applicationId;
    if (id) return { module: app.id, package: id, installTask, source: "last build" };
  }
  const build = app.build!;
  const id = /applicationId\s*=?\s*["']([\w.]+)["']/.exec(build)?.[1];
  const debugBlock = /(?:debug|getByName\(\s*["']debug["']\s*\))\s*\{([^}]*)\}/.exec(build)?.[1] ?? "";
  const suffix = /applicationIdSuffix\s*=?\s*["']([\w.]+)["']/.exec(debugBlock)?.[1] ?? "";
  return { module: app.id, package: id ? id + suffix : undefined, installTask, source: id ? "build file" : "none" };
}
