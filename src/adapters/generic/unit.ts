import { resolve } from "node:path";
import type { ProbeConfig } from "../../core/config.js";
import { readJUnitReports } from "../../core/junit.js";
import { isWindows, stream } from "../../core/proc.js";
import type { ModuleInfo, ModuleTestResult, TestCaseResult } from "../../core/types.js";
import type { UnitInvocation } from "../adapter.js";

/** Output lines kept per command, for failure messages. */
const TAIL = 400;

/**
 * Runs each distinct unit-test command of the modules once, in order. Modules sharing one
 * command (the project's `unit.command`) get one result between them, labelled with the
 * command. Results come from JUnit XML when `unit.junit` is set and was written, else from
 * the test runner's own summary line, else from the exit code alone.
 */
export async function runCommands(root: string, modules: ModuleInfo[], onLine: (line: string) => void, config: ProbeConfig): Promise<UnitInvocation> {
  const groups = new Map<string, ModuleInfo[]>();
  for (const m of modules) if (m.unitTestTask) groups.set(m.unitTestTask, [...(groups.get(m.unitTestTask) ?? []), m]);

  const results: ModuleTestResult[] = [];
  let exitCode = 0;
  for (const [command, members] of groups) {
    const label = members.length === 1 ? members[0]!.id : command;
    onLine(`$ ${command}`);
    const tail: string[] = [];
    const since = Date.now();
    const code = await runShell(command, root, (line) => {
      tail.push(line);
      if (tail.length > TAIL) tail.shift();
      onLine(line);
    });
    if (code !== 0 && exitCode === 0) exitCode = code;
    const junit = config.unit.junit ? readJUnitReports(label, resolve(root, config.unit.junit), since) : null;
    results.push(junit ?? fromOutput(label, tail) ?? fromExitCode(label, command, code, tail));
  }
  return { command: [...groups.keys()].join(" && "), exitCode, reused: [], results };
}

/** A whole command line through the platform's shell, so pipes, `&&` and env syntax work as typed. */
function runShell(command: string, cwd: string, onLine: (line: string) => void): Promise<number> {
  return isWindows ? stream(command, [], cwd, onLine) : stream("sh", ["-c", command], cwd, onLine);
}

/** A result that only knows whether the command passed: the command counts as one test. */
function fromExitCode(module: string, command: string, code: number, tail: string[]): ModuleTestResult {
  const failures: TestCaseResult[] = code === 0 ? [] : [{ name: `exit code ${code}`, className: command, status: "failed", durationMs: 0, message: lastLines(tail) }];
  return { module, tests: 1, failed: code === 0 ? 0 : 1, skipped: 0, durationMs: 0, failures };
}

function lastLines(tail: string[]): string {
  return tail.filter((l) => l.trim()).slice(-8).join("\n").slice(0, 1_000);
}

interface Counts {
  tests: number;
  failed: number;
  skipped: number;
}

/**
 * The summary the common test runners print last: node --test, Jest, Vitest, pytest and cargo.
 * Null when none is found; the exit code then decides.
 */
export function fromOutput(module: string, lines: string[]): ModuleTestResult | null {
  const text = lines.map(stripAnsi).join("\n");
  const counts = nodeCounts(text) ?? jestCounts(text) ?? vitestCounts(text) ?? pytestCounts(text) ?? cargoCounts(text);
  if (!counts) return null;
  const names = failedNames(text).slice(0, 50);
  const failures: TestCaseResult[] = names.map((name) => ({ name, className: "", status: "failed", durationMs: 0 }));
  if (counts.failed > 0 && failures.length === 0) failures.push({ name: `${counts.failed} failed`, className: "", status: "failed", durationMs: 0, message: lastLines(lines.map(stripAnsi)) });
  return { module, ...counts, durationMs: 0, failures };
}

function stripAnsi(line: string): string {
  return line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

function count(text: string, re: RegExp): number | undefined {
  const all = [...text.matchAll(re)];
  return all.length ? Number(all[all.length - 1]![1]) : undefined;
}

/** `ℹ tests 12` / `# tests 12` (node --test spec and TAP reporters). */
function nodeCounts(text: string): Counts | null {
  const tests = count(text, /^[ℹ#]\s+tests\s+(\d+)/gm);
  if (tests === undefined) return null;
  return { tests, failed: count(text, /^[ℹ#]\s+fail\s+(\d+)/gm) ?? 0, skipped: (count(text, /^[ℹ#]\s+skipped\s+(\d+)/gm) ?? count(text, /^[ℹ#]\s+skip\s+(\d+)/gm) ?? 0) + (count(text, /^[ℹ#]\s+todo\s+(\d+)/gm) ?? 0) };
}

/** `Tests:       1 failed, 2 skipped, 10 passed, 13 total` (Jest). */
function jestCounts(text: string): Counts | null {
  const line = [...text.matchAll(/^Tests:\s+(.+total)\s*$/gm)].pop()?.[1];
  if (!line) return null;
  const n = (word: string) => Number(new RegExp(`(\\d+) ${word}`).exec(line)?.[1] ?? 0);
  return { tests: n("total"), failed: n("failed"), skipped: n("skipped") + n("todo") };
}

/** `Tests  1 failed | 12 passed (13)` (Vitest). */
function vitestCounts(text: string): Counts | null {
  const m = [...text.matchAll(/^\s*Tests\s+(.+)\((\d+)\)\s*$/gm)].pop();
  if (!m) return null;
  const n = (word: string) => Number(new RegExp(`(\\d+) ${word}`).exec(m[1]!)?.[1] ?? 0);
  return { tests: Number(m[2]), failed: n("failed"), skipped: n("skipped") + n("todo") };
}

/** `==== 3 failed, 10 passed, 1 skipped in 0.52s ====` (pytest). */
function pytestCounts(text: string): Counts | null {
  const line = [...text.matchAll(/^=+ (.*\b(?:passed|failed|error)\b.*) in [\d.]+s.*=+\s*$/gm)].pop()?.[1];
  if (!line) return null;
  const n = (word: string) => Number(new RegExp(`(\\d+) ${word}`).exec(line)?.[1] ?? 0);
  const failed = n("failed") + n("errors?");
  const skipped = n("skipped") + n("xfailed");
  return { tests: n("passed") + failed + skipped + n("xpassed"), failed, skipped };
}

/** `test result: ok. 12 passed; 0 failed; 1 ignored` (cargo), summed over every test binary. */
function cargoCounts(text: string): Counts | null {
  const all = [...text.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored/g)];
  if (!all.length) return null;
  const sum = (i: number) => all.reduce((n, m) => n + Number(m[i]), 0);
  return { tests: sum(1) + sum(2) + sum(3), failed: sum(2), skipped: sum(3) };
}

/** Names of failing tests, as the runners list them. */
function failedNames(text: string): string[] {
  const names = [
    ...text.matchAll(/^\s*✖\s+(?!failing tests)(.+?)(?:\s+\([\d.]+m?s\))?\s*$/gm), // node --test
    ...text.matchAll(/^\s*●\s+(?!Test suite failed)(.+?)\s*$/gm), // Jest
    ...text.matchAll(/^\s*(?:×|FAIL)\s+(.+?)(?:\s+\d+m?s)?\s*$/gm), // Vitest
    ...text.matchAll(/^FAILED\s+(\S+)/gm), // pytest
    ...text.matchAll(/^test (\S+) \.\.\. FAILED$/gm), // cargo
  ].map((m) => m[1]!.trim());
  return [...new Set(names)];
}
