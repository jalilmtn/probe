import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";
import { listProjectFiles } from "../adapters/generic/areas.js";
import type { ScanResult, SecurityDismissal, SecurityFinding, Severity } from "../core/types.js";
import type { Project } from "../engine/project.js";

export const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];
export const severityRank = (s: Severity) => SEVERITY_ORDER.indexOf(s);

/** Build output, dependencies and vendored code: never the project's own source. */
const IGNORED = /(^|\/)(node_modules|bower_components|vendor|Pods|Carthage|\.git|\.gradle|\.idea|\.vscode|build|dist|out|target|\.next|\.nuxt|\.svelte-kit|\.output|coverage|\.turbo|\.cache|DerivedData|\.dart_tool|__pycache__|\.venv|venv|\.tox|bin|obj)\//;
const MINIFIED = /\.min\.(js|css)$|[-.]bundle\.js$|\.map$/;

/** Project files the static checks read, relative with forward slashes. */
export function securityFiles(project: Project): string[] {
  const extra = project.config.security?.ignorePaths ?? [];
  const extraRe = extra.length ? new RegExp(extra.map(globToRegex).join("|")) : null;
  return listProjectFiles(project.root, IGNORED).filter((f) => !MINIFIED.test(f) && !(extraRe && extraRe.test(f)));
}

export function globToRegex(glob: string): string {
  return `^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/?/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, ".*")}`;
}

/**
 * Which feature owns a file: the scanned module whose folder holds it (deepest wins).
 * Files outside every module (build scripts, CI, Dockerfiles) belong to "project".
 */
export function featureOwner(project: Project, scan: ScanResult | null): (file: string) => string {
  const dirs = (scan?.features ?? [])
    .flatMap((f) => f.modules.map((m) => ({ feature: f.id, dir: relative(project.root, resolve(project.root, m.dir)).replace(/\\/g, "/") })))
    .filter((d) => d.dir && !d.dir.startsWith(".."))
    .sort((a, b) => b.dir.length - a.dir.length);
  return (file) => dirs.find((d) => file === d.dir || file.startsWith(`${d.dir}/`))?.feature ?? "project";
}

/** Shows enough of a secret to recognise it, never enough to use it. */
export function mask(text: string): string {
  return text.replace(/[A-Za-z0-9+/_\-=]{8,}/g, (s) => `${s.slice(0, 4)}${"•".repeat(Math.min(12, s.length - 6))}${s.slice(-2)}`);
}

/** Stable across line moves and reformatting of the surrounding code. */
export function fingerprint(check: string, file: string | undefined, evidence: string): string {
  const norm = evidence.replace(/\s+/g, " ").trim().toLowerCase();
  return createHash("sha1").update(`${check}\u0000${file ?? ""}\u0000${norm}`).digest("hex").slice(0, 16);
}

export function makeFinding(f: Omit<SecurityFinding, "fingerprint">): SecurityFinding {
  return { ...f, evidence: f.evidence.slice(0, 400), fingerprint: fingerprint(f.check, f.file, f.evidence) };
}

// ── Dismissals: "not an issue here", with a reason, kept per machine and shared with nobody.

const DISMISSED = "security-dismissed.json";

export function loadDismissals(project: Project): SecurityDismissal[] {
  return project.store.read<SecurityDismissal[]>(DISMISSED) ?? [];
}

export function dismiss(project: Project, finding: SecurityFinding, reason: string): SecurityDismissal {
  if (!reason.trim()) throw new Error("Say why it is not an issue: the reason is what keeps a dismissal honest.");
  const list = loadDismissals(project).filter((d) => d.fingerprint !== finding.fingerprint);
  const entry: SecurityDismissal = { fingerprint: finding.fingerprint, check: finding.check, file: finding.file, reason: reason.trim(), at: new Date().toISOString() };
  project.store.write(DISMISSED, [...list, entry]);
  return entry;
}

export function undismiss(project: Project, fingerprintId: string): boolean {
  const list = loadDismissals(project);
  const next = list.filter((d) => d.fingerprint !== fingerprintId);
  project.store.write(DISMISSED, next);
  return next.length !== list.length;
}

/** Most severe first, then by file and line. */
export function sortFindings(list: SecurityFinding[]): SecurityFinding[] {
  return [...list].sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || (a.file ?? "").localeCompare(b.file ?? "") || (a.line ?? 0) - (b.line ?? 0));
}

/** One finding per fingerprint (two rules for the same check can hit the same spot). */
export function dedupe(list: SecurityFinding[]): SecurityFinding[] {
  const seen = new Map<string, SecurityFinding>();
  for (const f of list) {
    const prev = seen.get(f.fingerprint);
    if (!prev || severityRank(f.severity) < severityRank(prev.severity)) seen.set(f.fingerprint, f);
  }
  return [...seen.values()];
}
