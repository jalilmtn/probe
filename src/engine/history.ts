import { capture } from "../core/proc.js";

export interface Commit {
  hash: string;
  date: string;
  subject: string;
  tickets: string[];
  /** Looks like a bug fix: these become regression card candidates. */
  fix: boolean;
}

const TICKET = /\b[A-Z][A-Z0-9]+-\d+\b/g;
const FIX = /\b(fix|fixed|fixes|bug|bugfix|hotfix|crash|regression|broken)\b/i;

/** Recent non-merge commits touching any of `paths`, newest first. Empty outside a git repo. */
export function commitsTouching(root: string, paths: string[], limit = 80): Commit[] {
  if (paths.length === 0) return [];
  const out = capture("git", ["log", "--no-merges", `-n${limit}`, "--date=short", "--format=%h%x09%ad%x09%s", "--", ...paths], root);
  if (!out) return [];
  return out
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((p) => p.length >= 3)
    .map(([hash, date, ...rest]) => {
      const subject = rest.join("\t");
      return { hash: hash!, date: date!, subject, tickets: [...new Set(subject.match(TICKET) ?? [])], fix: FIX.test(subject) };
    });
}

/** The branch a change is compared with: the configured one, else the first that exists. */
export function defaultBase(root: string, configured?: string): string | null {
  for (const ref of configured ? [configured] : ["origin/develop", "develop", "origin/main", "main", "origin/master", "master"]) {
    // No "^{commit}" suffix: on Windows the command goes through cmd, where ^ is an escape.
    if (capture("git", ["rev-parse", "--verify", "--quiet", ref], root) !== null) return ref;
  }
  return null;
}

/**
 * Files a change touches: committed since it left `base`, plus uncommitted and untracked
 * work. Read-only git commands only; deleted files are kept, since removing code is a change too.
 */
export function changedFiles(root: string, base: string): string[] {
  const forkPoint = capture("git", ["merge-base", base, "HEAD"], root);
  if (!forkPoint) throw new Error(`Cannot compare with ${base}: no common history with HEAD.`);
  const lists = [
    capture("git", ["diff", "--name-only", `${forkPoint}...HEAD`], root),
    capture("git", ["diff", "--name-only", "HEAD"], root),
    capture("git", ["ls-files", "--others", "--exclude-standard"], root),
  ];
  return [...new Set(lists.flatMap((l) => (l ?? "").split("\n")).map((f) => f.trim()).filter(Boolean))].sort();
}

/** `git status --porcelain` paths, for seeing what an agent run changed. */
export function dirtyFiles(root: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of (capture("git", ["status", "--porcelain", "--untracked-files=all"], root) ?? "").split("\n")) {
    if (line.length > 3) out.set(line.slice(3).replace(/^"|"$/g, "").split(" -> ").pop()!, line.slice(0, 2));
  }
  return out;
}

/** Commit subjects mentioning a ticket id, newest first. */
export function commitsForTicket(root: string, ticket: string, limit = 50): Commit[] {
  const out = capture("git", ["log", "--no-merges", `-n${limit}`, "--date=short", "--format=%h%x09%ad%x09%s", "-i", `--grep=${ticket}`], root);
  if (!out) return [];
  return out
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((p) => p.length >= 3)
    .map(([hash, date, ...rest]) => {
      const subject = rest.join("\t");
      return { hash: hash!, date: date!, subject, tickets: [...new Set(subject.match(TICKET) ?? [])], fix: FIX.test(subject) };
    });
}

/** Files a commit touched. */
export function filesOfCommit(root: string, hash: string): string[] {
  return (capture("git", ["show", "--name-only", "--format=", hash], root) ?? "").split("\n").filter(Boolean);
}

/** Tracked files matching a git pathspec, e.g. "*.md". Empty outside a git repo. */
export function trackedFiles(root: string, pathspec: string): string[] {
  return (capture("git", ["ls-files", "--", pathspec], root) ?? "").split("\n").filter(Boolean);
}

export interface GitState {
  /** Checked-out branch; null on a detached HEAD. */
  branch: string | null;
  commit: string;
  /** Changed and untracked files: work a run tests that no commit holds. */
  dirty: number;
  upstream?: string;
  ahead?: number;
  behind?: number;
}

/** Where the working tree is, so a run can say which code it tested. Null outside a repo. */
export function gitState(root: string): GitState | null {
  const out = capture("git", ["status", "--porcelain=v2", "--branch", "--untracked-files=normal"], root);
  if (out === null) return null;
  const state: GitState = { branch: null, commit: "", dirty: 0 };
  for (const line of out.split("\n")) {
    if (line.startsWith("# branch.oid ")) state.commit = line.slice(13, 23);
    else if (line.startsWith("# branch.head ")) state.branch = line.slice(14) === "(detached)" ? null : line.slice(14).trim();
    else if (line.startsWith("# branch.upstream ")) state.upstream = line.slice(18).trim();
    else if (line.startsWith("# branch.ab ")) {
      const ab = /\+(\d+) -(\d+)/.exec(line);
      if (ab) [state.ahead, state.behind] = [Number(ab[1]), Number(ab[2])];
    } else if (line.trim() && !line.startsWith("#")) state.dirty++;
  }
  return state;
}

/** Branches a change can be compared with, local first. */
export function listBranches(root: string): string[] {
  const out = capture("git", ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads", "refs/remotes"], root) ?? "";
  return out
    .split("\n")
    .map((b) => b.trim())
    .filter((b) => b && !b.endsWith("/HEAD") && b !== "origin");
}
