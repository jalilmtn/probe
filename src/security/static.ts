import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isTestPath } from "../core/testfiles.js";
import type { SecurityFinding } from "../core/types.js";
import { makeFinding, mask } from "./findings.js";
import type { Rule } from "./rule.js";

const MAX_BYTES = 1024 * 1024;
/** `probe-security-ignore AND-WEB-07` on the line (or the one above) skips that check there. */
const IGNORE = /probe-security-ignore[:\s]+([A-Z]{2,4}-[\w-]+(?:\s*,\s*[A-Z]{2,4}-[\w-]+)*)/;

export interface StaticOptions {
  /** Who owns a file, for the finding's feature. */
  owner: (file: string) => string;
  /** Check ids or prefixes never reported. */
  skip: string[];
}

/** Runs rules over files and returns what they found. Unreadable and binary files are skipped. */
export function runStatic(root: string, files: string[], rules: Rule[], options: StaticOptions): SecurityFinding[] {
  const active = rules.filter((r) => !options.skip.some((s) => r.id === s || (s.endsWith("-") && r.id.startsWith(s))));
  const out: SecurityFinding[] = [];
  for (const file of files) {
    const mine = active.filter((r) => r.files.test(file));
    if (!mine.length) continue;
    const test = isTestPath(file);
    const presence = mine.filter((r) => r.fileOnly && (r.tests || !test));
    for (const r of presence) out.push(finding(r, file, undefined, file, options.owner(file)));
    const readers = mine.filter((r) => !r.fileOnly && (r.tests || !test));
    if (!readers.length) continue;
    const text = readText(join(root, file));
    if (text === null) continue;
    for (const r of readers) out.push(...matchRule(r, file, text, options.owner(file)));
  }
  return out;
}

/** One rule on one file's text. Exported for the fix re-check, which runs a single rule again. */
export function matchRule(r: Rule, file: string, text: string, feature: string): SecurityFinding[] {
  if (r.when && !r.when.test(text)) return [];
  if (r.unless && r.unless.test(text)) return [];
  if (r.absent) {
    if (r.match && r.match.test(text)) return [];
    return [finding(r, file, undefined, `${file}: ${r.title.charAt(0).toLowerCase()}${r.title.slice(1)}`, feature)];
  }
  if (!r.match) return [];
  const out: SecurityFinding[] = [];
  const re = new RegExp(r.match.source, r.match.flags.includes("g") ? r.match.flags : `${r.match.flags}g`);
  const lines = lineStarts(text);
  let m: RegExpExecArray | null;
  let hits = 0;
  while ((m = re.exec(text)) !== null && hits < 20) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    const line = lineOf(lines, m.index);
    if (!ignored(text, lines, line, r.id)) {
      out.push(finding(r, file, line + 1, m[0], feature));
      hits++;
    }
  }
  return out;
}

function finding(r: Rule, file: string, line: number | undefined, evidence: string, feature: string): SecurityFinding {
  const shown = evidence.replace(/\s+/g, " ").trim().slice(0, 240);
  return makeFinding({
    check: r.id,
    title: r.title,
    severity: r.severity,
    layer: "static",
    file,
    line,
    evidence: r.secret ? mask(shown) : shown,
    why: r.why,
    fix: r.fix,
    refs: r.refs,
    feature,
  });
}

export function readText(path: string): string | null {
  try {
    if (statSync(path).size > MAX_BYTES) return null;
    const buf = readFileSync(path);
    if (buf.subarray(0, 8000).includes(0)) return null;
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function lineOf(starts: number[], index: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function ignored(text: string, starts: number[], line: number, id: string): boolean {
  for (const l of [line, line - 1]) {
    if (l < 0) continue;
    const s = text.slice(starts[l], starts[l + 1] ?? text.length);
    const m = IGNORE.exec(s);
    if (m && m[1]!.split(/\s*,\s*/).some((x) => x === id || id.startsWith(x))) return true;
  }
  return false;
}
