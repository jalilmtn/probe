import { spawnSync } from "node:child_process";
import type { SecurityFinding } from "../core/types.js";
import { makeFinding, mask } from "./findings.js";
import type { Rule } from "./rule.js";

/**
 * Secrets added in recent commits, found in the diff lines git kept. A secret deleted from the
 * code is still in every clone; only rotating it helps. Returns nothing without git.
 */
export function historyFindings(root: string, rules: Rule[], commits: number, owner: (file: string) => string): SecurityFinding[] {
  const secretRules = rules.filter((r) => r.secret && r.match && !r.absent && !r.fileOnly && !r.when && r.platform === "common");
  const keyFiles = rules.filter((r) => r.fileOnly && r.id === "COM-SEC-02");
  if (!secretRules.length || commits <= 0) return [];
  const git = spawnSync("git", ["log", "--all", `--max-count=${commits}`, "-p", "-U0", "--no-color", "--no-ext-diff", "--diff-filter=AM", "--format=@@@commit %h %ad", "--date=short"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 512 * 1024 * 1024,
    timeout: 120_000,
  });
  if (git.error || git.status !== 0) return [];

  const out: SecurityFinding[] = [];
  let commit = "";
  let file = "";
  for (const line of git.stdout.split("\n")) {
    if (line.startsWith("@@@commit ")) {
      commit = line.slice(10).trim();
      continue;
    }
    if (line.startsWith("+++ b/")) {
      file = line.slice(6);
      if (keyFiles.some((r) => r.files.test(file))) out.push(found(keyFiles[0]!, file, commit, file, owner(file)));
      continue;
    }
    if (!line.startsWith("+") || line.startsWith("+++") || line.length > 2000) continue;
    for (const r of secretRules) {
      if (!r.files.test(file)) continue;
      const m = r.match!.exec(line);
      if (m && !(r.unless && r.unless.test(line))) out.push(found(r, file, commit, m[0], owner(file)));
    }
  }
  return out;
}

/** The fingerprint leaves the commit out, so one secret in many commits is one finding. */
function found(r: Rule, file: string, commit: string, evidence: string, feature: string): SecurityFinding {
  const shown = r.fileOnly ? evidence : mask(evidence);
  const f = makeFinding({
    check: r.id === "COM-SEC-02" && r.fileOnly ? "COM-SEC-05" : r.id,
    title: `${r.title} (in git history)`,
    severity: r.severity === "critical" ? "high" : r.severity,
    layer: "history",
    file,
    evidence: shown,
    why: `${r.why} It is in commit ${commit.split(" ")[0]}, so every clone of the repository still has it, even if the current code no longer does.`,
    fix: "Rotate the secret first (that is what actually protects you), then purge it from history with git filter-repo or BFG and force-push, and ask collaborators to re-clone.",
    refs: [...r.refs, "COM-SEC-05"],
    feature,
  });
  return { ...f, evidence: `${shown} · commit ${commit}` };
}
