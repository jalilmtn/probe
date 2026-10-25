import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ModuleTestResult, TestCaseResult } from "../../core/types.js";

/** Parses the JUnit XML reports Gradle writes to `build/test-results/<task>/`. */
export function readJUnitResults(moduleId: string, resultsDir: string, sinceMs: number): ModuleTestResult | null {
  if (!existsSync(resultsDir)) return null;
  const files = readdirSync(resultsDir)
    .filter((f) => f.startsWith("TEST-") && f.endsWith(".xml"))
    .map((f) => join(resultsDir, f))
    // Gradle keeps up-to-date reports when nothing changed; a small slack keeps those
    // from a cached task while still dropping reports from earlier runs.
    .filter((f) => statSync(f).mtimeMs >= sinceMs - 2_000);
  if (files.length === 0) return null;

  const result: ModuleTestResult = { module: moduleId, tests: 0, failed: 0, skipped: 0, durationMs: 0, failures: [] };
  for (const file of files) {
    const xml = readFileSync(file, "utf8");
    for (const tc of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
      const attrs = tc[1]!;
      const body = tc[3] ?? "";
      const status: TestCaseResult["status"] = /<(failure|error)\b/.test(body)
        ? "failed"
        : /<skipped\b/.test(body)
          ? "skipped"
          : "passed";
      const durationMs = Math.round(Number(attr(attrs, "time") ?? 0) * 1000);
      result.tests++;
      result.durationMs += durationMs;
      if (status === "skipped") result.skipped++;
      if (status === "failed") {
        result.failed++;
        result.failures.push({
          name: decode(attr(attrs, "name") ?? "?"),
          className: decode(attr(attrs, "classname") ?? "?"),
          status,
          durationMs,
          message: decode(/<(?:failure|error)\b[^>]*message="([^"]*)"/.exec(body)?.[1] ?? firstLine(body)),
        });
      }
    }
  }
  return result;
}

function attr(attrs: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1];
}

function firstLine(body: string): string {
  return body.replace(/<[^>]+>/g, "").trim().split("\n")[0]?.slice(0, 300) ?? "";
}

function decode(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#10;/g, "\n")
    .replace(/&amp;/g, "&");
}
