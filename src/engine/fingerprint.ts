import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { relative } from "node:path";
import type { Card, ModuleInfo } from "../core/types.js";
import type { Project } from "./project.js";

function git(root: string, args: string[], input?: string): string {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", input, maxBuffer: 512 * 1024 * 1024, timeout: 60_000 });
  return r.status === 0 ? r.stdout : "";
}

const short = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12);

/**
 * The content of the working tree, per module, as git blob ids: committed files from the index,
 * changed and untracked files hashed as they are on disk (read-only `git hash-object`, nothing
 * written). Two machines with the same files get the same fingerprint, committed or not.
 */
export class ContentIndex {
  /** Module id → its files as "path blob" lines (sorted), own files only (nested modules excluded). */
  private readonly files = new Map<string, string[]>();
  private readonly testFiles = new Map<string, string[]>();
  private readonly deps: Map<string, string[]>;

  constructor(private readonly project: Project, modules: ModuleInfo[]) {
    const root = project.root;
    const blobs = new Map<string, string>();
    for (const line of git(root, ["ls-files", "-s", "-z"]).split("\0")) {
      const m = /^\d+ ([0-9a-f]+) \d\t(.+)$/.exec(line);
      if (m) blobs.set(m[2]!, m[1]!);
    }
    // Status paths are relative to the repository root; everything else here to the project.
    const prefix = git(root, ["rev-parse", "--show-prefix"]).trim();
    const changed: string[] = [];
    const entries = git(root, ["status", "--porcelain", "-z", "--untracked-files=all"]).split("\0");
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!;
      if (e.length < 4) continue;
      const [x, y, full] = [e[0], e[1], e.slice(3)];
      if (x === "R" || x === "C") i++; // the next entry is the rename's source
      if (!full.startsWith(prefix)) continue;
      const path = full.slice(prefix.length);
      if (x === "D" || y === "D") blobs.delete(path);
      else changed.push(path);
    }
    if (changed.length) {
      const hashes = git(root, ["hash-object", "--stdin-paths"], changed.join("\n") + "\n").split("\n");
      changed.forEach((p, n) => hashes[n] && blobs.set(p, hashes[n]!.trim()));
    }

    const byDir = new Map(modules.map((m) => [relative(root, m.dir).replace(/\\/g, "/"), m.id]));
    for (const [path, blob] of blobs) {
      // Probe's own files (results, cards) are never part of what a result depends on.
      if (path.startsWith("probe/")) continue;
      let dir = path;
      let owner: string | undefined;
      while (dir.includes("/") && !owner) {
        dir = dir.slice(0, dir.lastIndexOf("/"));
        owner = byDir.get(dir);
      }
      if (!owner) continue;
      const target = project.adapter.isTestSource(path) ? this.testFiles : this.files;
      const list = target.get(owner);
      if (list) list.push(`${path} ${blob}`);
      else target.set(owner, [`${path} ${blob}`]);
    }
    for (const list of [...this.files.values(), ...this.testFiles.values()]) list.sort();
    this.deps = project.adapter.moduleDependencies(root);
  }

  /** Hash of one module's files; with `tests`, its test sources too (unit results depend on them, device results do not). */
  module(id: string, tests: boolean): string {
    // Every card and feature of a scan asks for the same shared modules: hash each once.
    const key = `${tests ? "t" : "m"}${id}`;
    let hash = this.hashes.get(key);
    if (hash === undefined) {
      const lines = [...(this.files.get(id) ?? []), ...(tests ? (this.testFiles.get(id) ?? []) : [])];
      hash = short(lines.join("\n"));
      this.hashes.set(key, hash);
    }
    return hash;
  }

  private readonly hashes = new Map<string, string>();

  /** Modules these modules depend on, directly or not, themselves excluded. */
  dependenciesOf(ids: string[]): string[] {
    const seen = new Set<string>();
    const queue = [...ids];
    while (queue.length) {
      for (const d of this.deps.get(queue.shift()!) ?? []) {
        if (!seen.has(d)) {
          seen.add(d);
          queue.push(d);
        }
      }
    }
    for (const id of ids) seen.delete(id);
    return [...seen].sort();
  }

  /** What a result depends on: its own modules one by one, the card, and everything they depend on as one hash. */
  fingerprint(own: string[], tests: boolean, card?: Card): Fingerprint {
    const deps = this.dependenciesOf(own);
    return {
      own: Object.fromEntries(own.map((id) => [id, this.module(id, tests)])),
      deps: short(deps.map((id) => `${id} ${this.module(id, false)}`).join("\n")),
      card: card ? cardHash(card) : undefined,
    };
  }
}

export interface Fingerprint {
  own: Record<string, string>;
  deps: string;
  card?: string;
}

/** What a card asks, without review status, sources or timestamps, which change when it passes. */
export function cardHash(card: Card): string {
  const { title, summary, reach, preconditions, steps, expect, accounts } = card;
  return short(JSON.stringify({ title, summary, reach, preconditions, steps, expect, accounts }));
}
