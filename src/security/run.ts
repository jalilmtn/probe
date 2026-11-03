import { existsSync } from "node:fs";
import { join } from "node:path";
import { newRunId } from "../core/store.js";
import { throwIfStopped } from "../core/proc.js";
import type { SecurityDismissal, SecurityFinding, SecurityLayer, SecurityRun } from "../core/types.js";
import { findIssue } from "../engine/issues.js";
import { resolveApp } from "../engine/app.js";
import type { Project } from "../engine/project.js";
import { launchRun } from "../engine/runs.js";
import { findFeature, latestScan } from "../engine/scan.js";
import { agentFindings } from "./agent.js";
import { artifactFindings } from "./artifact.js";
import { rulesFor, RULES } from "./catalog/index.js";
import { osvFindings, readDependencies } from "./deps.js";
import { dedupe, dismiss, featureOwner, loadDismissals, securityFiles, severityRank, sortFindings } from "./findings.js";
import { historyFindings } from "./history.js";
import { detectPlatforms } from "./platforms.js";
import { androidRuntimeFindings, webRuntimeFindings } from "./runtime.js";
import { matchRule, readText, runStatic } from "./static.js";

export interface SecurityOptions {
  /** One feature only: its files and an agent review of it. Unset: the whole project. */
  feature?: string;
  /** Layers to run; unset: every layer that can run here (the agent only when `agent` is true). */
  layers?: SecurityLayer[];
  /** Also have an agent review the code (costs an agent run per feature). */
  agent?: boolean;
  /** At most this many features get an agent review in a whole-project run. */
  agentLimit?: number;
  /** Local URL of the running app, overriding security.url. */
  url?: string;
  model?: string;
}

export const ALL_LAYERS: SecurityLayer[] = ["static", "deps", "history", "artifact", "runtime", "agent"];

/**
 * Security checks over the project (or one feature): pattern rules for its platforms,
 * dependencies against OSV, secrets in git history, the built app, the running app, and
 * optionally an agent reading the code. Findings become issues with a fix prompt and Fix.
 */
export function startSecurityRun(project: Project, options: SecurityOptions = {}): { run: SecurityRun; done: Promise<SecurityRun> } {
  const run: SecurityRun = {
    id: newRunId(),
    kind: "security",
    feature: options.feature ?? "*",
    startedAt: new Date().toISOString(),
    status: "running",
    platforms: [],
    layers: [],
    findings: [],
    dismissed: 0,
    files: 0,
    costUsd: 0,
  };

  return launchRun(project, run, async (log) => {
    const cfg = project.config.security;
    const wanted = new Set(options.layers ?? ALL_LAYERS.filter((l) => l !== "agent" || options.agent));
    if (options.agent) wanted.add("agent");
    const scan = latestScan(project);
    const owner = featureOwner(project, scan);
    const feature = options.feature ? findFeature(scan, options.feature) : undefined;
    if (options.feature && !feature && options.feature !== "project") throw new Error(`Unknown feature ${options.feature}. Run probe scan to see the features.`);
    const projectWide = !options.feature;

    const allFiles = securityFiles(project);
    const platforms = detectPlatforms(project.root, allFiles);
    run.platforms = [...platforms].sort();
    log(`platforms: ${run.platforms.join(", ") || "none detected (common checks only)"}`);
    const rules = rulesFor(platforms);
    const files = options.feature ? allFiles.filter((f) => owner(f) === (feature?.id ?? "project")) : allFiles;
    const found: SecurityFinding[] = [];
    const layer = async (name: SecurityLayer, work: () => Promise<string | void> | string | void, skipWhy?: string) => {
      throwIfStopped();
      if (!wanted.has(name)) return;
      if (skipWhy) {
        run.layers.push({ layer: name, status: "skipped", note: skipWhy });
        log(`── ${name}: skipped (${skipWhy})`);
        return;
      }
      log(`── ${name}`);
      try {
        const note = await work();
        run.layers.push({ layer: name, status: "ran", note: note || undefined });
      } catch (e) {
        run.layers.push({ layer: name, status: "error", note: (e as Error).message });
        log(`  error: ${(e as Error).message}`);
      }
    };

    await layer("static", () => {
      const before = found.length;
      found.push(...runStatic(project.root, files, rules, { owner, skip: cfg.skip }));
      run.files = files.length;
      log(`  ${rules.length} rules over ${files.length} files: ${found.length - before} finding(s)`);
      return `${rules.length} rules, ${files.length} files`;
    });

    await layer(
      "deps",
      async () => {
        const { deps, unpinned } = readDependencies(project.root, allFiles);
        found.push(...unpinned.map((f) => ({ ...f, feature: owner(f.file ?? "") })));
        log(`  ${deps.length} pinned dependencies from lockfiles`);
        if (!cfg.osv) return `${deps.length} dependencies; OSV lookup off (security.osv)`;
        if (!deps.length) return "no lockfile with exact versions";
        found.push(...(await osvFindings(deps, owner, log)));
        return `${deps.length} dependencies checked against OSV`;
      },
      projectWide ? undefined : "project-wide; run without a feature",
    );

    await layer(
      "history",
      () => {
        const hits = historyFindings(project.root, rules, cfg.historyCommits, owner);
        // A secret still in the code is reported once, by the static layer.
        const inCode = new Set(found.filter((f) => f.layer === "static").map((f) => `${f.check}|${f.file}`));
        const fresh = hits.filter((f) => !inCode.has(`${f.check}|${f.file}`));
        found.push(...fresh);
        log(`  last ${cfg.historyCommits} commits: ${fresh.length} secret(s) only in history`);
        return `last ${cfg.historyCommits} commits`;
      },
      !projectWide ? "project-wide; run without a feature" : cfg.historyCommits <= 0 ? "security.historyCommits is 0" : !existsSync(join(project.root, ".git")) ? "not a git repository" : undefined,
    );

    await layer(
      "artifact",
      () => {
        const { findings, scanned } = artifactFindings(project.root, rules, owner);
        found.push(...findings);
        log(scanned.length ? `  read ${scanned.join(", ")}` : "  no built app or web bundle on disk (build one to check what ships)");
        return scanned.length ? scanned.join(", ") : "nothing built yet";
      },
      projectWide ? undefined : "project-wide; run without a feature",
    );

    const url = options.url ?? cfg.url;
    const pkg = platforms.has("android") ? safePackage(project) : undefined;
    await layer(
      "runtime",
      async () => {
        const notes: string[] = [];
        if (url) {
          found.push(...(await webRuntimeFindings(url, log)));
          notes.push(url);
        }
        if (pkg) {
          found.push(...androidRuntimeFindings(project, pkg, rules, log));
          notes.push(pkg);
        }
        return notes.join(", ");
      },
      !projectWide ? "project-wide; run without a feature" : !url && !pkg ? "no security.url set and no Android app package found" : undefined,
    );

    await layer("agent", async () => {
      const targets = feature
        ? [feature]
        : scan.features
            .slice()
            .sort((a, b) => (a.group === b.group ? b.stats.classes - a.stats.classes : a.group === "feature" ? -1 : 1))
            .slice(0, options.agentLimit ?? 3);
      for (const f of targets) {
        throwIfStopped();
        log(`  reviewing ${f.id}`);
        const r = await agentFindings(project, f, platforms, found, log, options.model);
        run.costUsd += r.costUsd;
        found.push(...r.findings);
        log(`  ${f.id}: ${r.findings.length} finding(s)${r.error ? ` (${r.error})` : ""}`);
      }
      return `${targets.map((t) => t.id).join(", ")}`;
    });

    const dismissed = new Set(loadDismissals(project).map((d) => d.fingerprint));
    const all = dedupe(found);
    run.findings = sortFindings(all.filter((f) => !dismissed.has(f.fingerprint)));
    run.dismissed = all.length - run.findings.length;
    const counts = countBySeverity(run.findings);
    log(`${run.findings.length} open finding(s): ${counts}${run.dismissed ? ` · ${run.dismissed} dismissed` : ""}`);
    const failing = run.findings.filter((f) => severityRank(f.severity) <= severityRank(cfg.failOn));
    run.status = failing.length ? "failed" : "passed";
    if (failing.length) run.error = `${failing.length} finding(s) at ${cfg.failOn} or above.`;
  });
}

function safePackage(project: Project): string | undefined {
  try {
    return resolveApp(project).package;
  } catch {
    return undefined;
  }
}

export function countBySeverity(list: SecurityFinding[]): string {
  const n = (s: string) => list.filter((f) => f.severity === s).length;
  return (["critical", "high", "medium", "low", "info"] as const).filter((s) => n(s)).map((s) => `${n(s)} ${s}`).join(", ") || "none";
}

export function summarizeSecurity(run: SecurityRun): string {
  const lines = [`Security ${run.id} · ${run.feature === "*" ? "whole project" : run.feature} · ${run.status.toUpperCase()} · ${run.findings.length} open (${countBySeverity(run.findings)})${run.dismissed ? ` · ${run.dismissed} dismissed` : ""}${run.costUsd ? ` · $${run.costUsd.toFixed(2)}` : ""}`];
  lines.push(`  platforms: ${run.platforms.join(", ") || "—"}`);
  lines.push(`  layers: ${run.layers.map((l) => `${l.layer} ${l.status}${l.note && l.status !== "ran" ? ` (${l.note})` : ""}`).join(" · ")}`);
  if (run.error && run.status === "error") lines.push(run.error);
  run.findings.slice(0, 60).forEach((f, n) => lines.push(`  ${run.id}:${n}  [${f.severity}] ${f.check} ${f.title}${f.file ? ` — ${f.file}${f.line ? `:${f.line}` : ""}` : ""}`));
  if (run.findings.length > 60) lines.push(`  … ${run.findings.length - 60} more (probe issues ${run.id})`);
  if (run.findings.length) lines.push("", `Fix one: probe fix-prompt <issue id> (a prompt to paste) or probe fix <issue id> (an agent). Not an issue here: probe security-dismiss <issue id> "<reason>".`);
  return lines.join("\n");
}

/**
 * Whether a finding is still there, by running the same check again on the current code. Used
 * after a fix. `count` is how many places that check hits in that file, so fixing one of two
 * hits is seen as progress rather than "still there".
 */
export async function recheckFinding(project: Project, finding: SecurityFinding): Promise<{ checked: boolean; stillFound: boolean; count: number; note: string }> {
  if (finding.layer === "static" && finding.file) {
    const rules = RULES.filter((r) => r.id === finding.check && r.files.test(finding.file!));
    if (!rules.length) return { checked: false, stillFound: false, count: 0, note: `no rule ${finding.check} for ${finding.file}` };
    if (rules.some((r) => r.fileOnly)) {
      const there = existsSync(join(project.root, finding.file));
      return { checked: true, stillFound: there, count: there ? 1 : 0, note: there ? `${finding.file} is still in the project` : `${finding.file} is gone` };
    }
    const text = readText(join(project.root, finding.file));
    if (text === null) return { checked: true, stillFound: false, count: 0, note: `${finding.file} no longer exists` };
    const hits = rules.flatMap((r) => matchRule(r, finding.file!, text, finding.feature));
    const same = hits.some((h) => h.fingerprint === finding.fingerprint);
    return { checked: true, stillFound: same, count: hits.length, note: same ? `${finding.check} still matches ${finding.file}` : hits.length ? `the original match is gone; ${hits.length} other ${finding.check} match(es) remain in ${finding.file}` : `${finding.check} no longer matches ${finding.file}` };
  }
  if (finding.layer === "deps" && finding.file) {
    const { deps } = readDependencies(project.root, [finding.file]);
    const [name, version] = finding.evidence.split(" ");
    const still = deps.some((d) => d.name === name && d.version === version);
    return { checked: true, stillFound: still, count: still ? 1 : 0, note: still ? `${name} ${version} is still locked in ${finding.file} (update the lockfile too)` : `${name} ${version} is no longer in ${finding.file}` };
  }
  if (finding.layer === "runtime" && !finding.check.startsWith("AND-")) {
    if (!project.config.security.url) return { checked: false, stillFound: false, count: 0, note: "restart the app and run probe security to check it" };
    const now = await webRuntimeFindings(project.config.security.url, () => {});
    const still = now.some((f) => f.check === finding.check && f.title === finding.title);
    return { checked: true, stillFound: still, count: still ? 1 : 0, note: still ? "the running app still shows it (restarted after the change?)" : "the running app no longer shows it" };
  }
  const why: Record<string, string> = {
    history: "a secret in history stays until it is rotated and purged; Probe cannot check that",
    artifact: "rebuild the app, then run probe security to check what ships",
    runtime: "reinstall or restart the app, then run probe security",
    agent: "an agent finding has no rule to re-run: review the change",
  };
  return { checked: false, stillFound: false, count: 0, note: why[finding.layer] ?? "no automatic re-check" };
}

/** "Not an issue here": hides the finding from later runs, with the reason kept beside it. */
export function dismissIssue(project: Project, issueId: string, reason: string): SecurityDismissal {
  const found = findIssue(project, issueId);
  if (!found?.issue.security) throw new Error(`No security issue ${issueId}.`);
  return dismiss(project, found.issue.security, reason);
}
