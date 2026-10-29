// Test-file conventions shared by every adapter that has no build tool to ask: a file is test
// code by its name (`*.test.ts`, `foo_test.go`, `test_foo.py`, `FooTest.kt`) or by the folder
// it sits in (`test/`, `tests/`, `__tests__/`, `src/test/`).

/** Source code Probe inventories when no adapter knows better. */
export const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|rb|php|cs|cpp|cc|c|h|hpp|m|mm|scala|dart|ex|exs|lua|vue|svelte)$/;

const TEST_NAME = /(\.(test|spec)\.[^./]+$)|(_(test|spec)\.[^./]+$)|(^test_[^/]*\.py$)|((Test|Tests|Spec)\.(kt|java|swift|cs|scala|php)$)/;
const TEST_DIR = /(^|\/)(test|tests|__tests__|spec|specs|src\/(test|androidTest|testFixtures|sharedTest)[^/]*)\//;

/** Whether a project-relative path is test code. */
export function isTestPath(relPath: string): boolean {
  const path = relPath.replace(/\\/g, "/");
  const name = path.slice(path.lastIndexOf("/") + 1);
  return TEST_NAME.test(name) || TEST_DIR.test(path);
}

/** Folders that only ever hold tests: they never form an area of their own. */
export const TEST_ONLY_DIRS = new Set(["test", "tests", "__tests__", "spec", "specs", "e2e"]);

/** `jobs.test.ts` → `jobs`, `test_jobs.py` → `jobs`, `JobsTest.kt` → `Jobs`: the unit a test file is named after. */
export function testedName(fileName: string): string {
  return fileName
    .replace(/\.[^.]+$/, "")
    .replace(/[._-](test|spec)$/i, "")
    .replace(/^test_/, "")
    .replace(/(Test|Tests|Spec)$/, "");
}

/** A file's name without its extension, the way test files and manifests refer to it. */
export function stemOf(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "");
}

/** Test names declared in a test file: Kotlin backticks, JS `test("…")`/`it("…")`, Python/Go test functions, plain methods. */
export function testNamesIn(text: string): string[] {
  return [
    ...text.matchAll(/fun\s+`([^`]+)`/g),
    ...text.matchAll(/(?:fun|void)\s+([A-Za-z_]\w*)\s*\(/g),
    ...text.matchAll(/\b(?:test|it)(?:\.\w+)?\(\s*(["'`])((?:(?!\1).)+)\1/g),
    ...text.matchAll(/\bdef\s+(test_\w+)\s*\(/g),
    ...text.matchAll(/\bfunc\s+(Test\w+)\s*\(/g),
  ].map((m) => m[m.length - 1]!);
}
