import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
  }

  writeRun(id: string, value: unknown): void {
    this.write(join("runs", `${id}.json`), value);
  }

  listRuns<T>(): T[] {
    return readdirSync(join(this.dir, "runs"))
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse()
      .map((f) => this.read<T>(join("runs", f)))
      .filter((r): r is T => r !== null);
  }
}

export function newRunId(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
}
