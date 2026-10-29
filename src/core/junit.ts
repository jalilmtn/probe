import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ModuleTestResult, TestCaseResult } from "./types.js";

/**
 * JUnit XML, the report format nearly every test runner can write (Gradle, Maven, Jest,
 * Vitest, pytest, go-junit-report, node --test-reporter=junit). Adds every `<testcase>` of
 * `xml` to `result`.
 */
export function addJUnitXml(result: ModuleTestResult, xml: string): void {
  for (const tc of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attrs = tc[1]!;
    const body = tc[3] ?? "";
    const status: TestCaseResult["status"] = /<(failure|error)\b/.test(body) ? "failed" : /<skipped\b/.test(body) ? "skipped" : "passed";
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

/**
 * Reads JUnit reports for one module from a file, or from the `.xml` files of a folder and its
 * subfolders, written at or after `sinceMs`. Null when there is none, so a stale report is never
 * passed off as this run's.
 */
export function readJUnitReports(moduleId: string, path: string, sinceMs: number, filter: (name: string) => boolean = (n) => n.endsWith(".xml")): ModuleTestResult | null {
  const files = reportFiles(path, filter).filter((f) => statSync(f).mtimeMs >= sinceMs - 2_000);
  if (files.length === 0) return null;
  const result: ModuleTestResult = { module: moduleId, tests: 0, failed: 0, skipped: 0, durationMs: 0, failures: [] };
  for (const file of files) addJUnitXml(result, readFileSync(file, "utf8"));
  return result;
}

function reportFiles(path: string, filter: (name: string) => boolean): string[] {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return [path];
  const out: string[] = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const p = join(path, entry.name);
    if (entry.isDirectory()) out.push(...reportFiles(p, filter));
    else if (filter(entry.name)) out.push(p);
  }
  return out;
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
