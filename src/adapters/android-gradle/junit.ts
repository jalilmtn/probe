import { readJUnitReports } from "../../core/junit.js";
import type { ModuleTestResult } from "../../core/types.js";

/**
 * Parses the JUnit XML reports Gradle writes to `build/test-results/<task>/`. Gradle keeps
 * up-to-date reports when nothing changed; the reader's small slack keeps those from a cached
 * task while still dropping reports from earlier runs.
 */
export function readJUnitResults(moduleId: string, resultsDir: string, sinceMs: number): ModuleTestResult | null {
  return readJUnitReports(moduleId, resultsDir, sinceMs, (f) => f.startsWith("TEST-") && f.endsWith(".xml"));
}
