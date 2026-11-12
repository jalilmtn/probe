import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

/**
 * Local, per-machine results (scans, runs, later videos). Kept in the user's home rather than
 * in the project so Probe never leaves untracked files in someone's repo.
 */
export class Store {
  readonly dir: string;

  constructor(projectRoot: string) {
    const abs = resolve(projectRoot);
    const hash = createHash("sha1").update(abs.toLowerCase()).digest("hex").slice(0, 10);
    this.dir = join(homedir(), ".probe", "projects", `${basename(abs)}-${hash}`);
    mkdirSync(join(this.dir, "runs"), { recursive: true });
  }

  read<T>(name: string): T | null {
    const file = join(this.dir, name);
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, "utf8")) as T;
  }

  write(name: string, value: unknown): void {
    writeFileSync(join(this.dir, name), JSON.stringify(value, null, 2));
    for (const fn of writeListeners) fn(this.dir, name);
  }

  writeRun(id: string, value: unknown): void {
    this.write(join("runs", `${id}.json`), value);
  }

  /**
   * Every saved run, newest first. A run file is parsed once and reused while its size and time
   * stay the same: Studio lists runs on most pages, and hundreds of them hold megabytes.
   */
  listRuns<T>(): T[] {
    const dir = join(this.dir, "runs");
    const out: T[] = [];
    const seen = new Set<string>();
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).sort().reverse()) {
      const file = join(dir, f);
      seen.add(file);
      let stamp: string;
      try {
        const st = statSync(file);
        stamp = `${st.size}:${st.mtimeMs}`;
      } catch {
        continue;
      }
      const hit = parsedRuns.get(file);
      if (hit && hit.stamp === stamp) {
        out.push(hit.run as T);
        continue;
      }
      try {
        const run = JSON.parse(readFileSync(file, "utf8")) as T;
        parsedRuns.set(file, { stamp, run });
        out.push(run);
      } catch {
        // Half written: the next listing reads it again.
      }
    }
    for (const file of parsedRuns.keys()) if (file.startsWith(dir) && !seen.has(file)) parsedRuns.delete(file);
    return out;
  }
}

/** Parsed run files by path, with the size and time they had when read. */
const parsedRuns = new Map<string, { stamp: string; run: unknown }>();

type WriteListener = (storeDir: string, name: string) => void;
const writeListeners = new Set<WriteListener>();

/** Calls `fn` after every write to any project's store (Studio drops what it cached). */
export function onStoreWrite(fn: WriteListener): () => void {
  writeListeners.add(fn);
  return () => writeListeners.delete(fn);
}

const issued = new Set<string>();

/**
 * A run id from the time, to the second. Runs that start in the same second (a check and the
 * unit run it starts) get a suffix, or the second one's record would overwrite the first.
 */
export function newRunId(): string {
  const base = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  let id = base;
  for (let n = 2; issued.has(id); n++) id = `${base}-${n}`;
  issued.add(id);
  return id;
}
