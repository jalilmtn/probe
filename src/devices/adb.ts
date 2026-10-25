import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isWindows } from "../core/proc.js";

/** SDK root from ANDROID_HOME / ANDROID_SDK_ROOT, else the project's local.properties. */
export function androidSdk(projectRoot?: string): string | null {
  const env = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  if (env && existsSync(env)) return env;
  if (!projectRoot) return null;
  const local = join(projectRoot, "local.properties");
  if (!existsSync(local)) return null;
  const raw = /^sdk\.dir=(.*)$/m.exec(readFileSync(local, "utf8"))?.[1];
  const dir = raw?.trim().replace(/\\:/g, ":").replace(/\\\\/g, "\\");
  return dir && existsSync(dir) ? dir : null;
}

export function sdkTool(projectRoot: string | undefined, ...path: string[]): string {
  const sdk = androidSdk(projectRoot);
  const exe = join(...path) + (isWindows ? ".exe" : "");
  return sdk && existsSync(join(sdk, exe)) ? join(sdk, exe) : path[path.length - 1]!;
}

/**
 * Runs adb without a shell: arguments reach adb exactly as given, so device-side strings
 * (text to type, shell commands) only need escaping for the device's own shell.
 */
export class Adb {
  constructor(readonly bin: string) {}

  static forProject(projectRoot?: string): Adb {
    return new Adb(sdkTool(projectRoot, "platform-tools", "adb"));
  }

  run(args: string[], timeoutMs = 30_000): { ok: boolean; out: string; err: string } {
    const r = spawnSync(this.bin, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
    return { ok: !r.error && r.status === 0, out: r.stdout ?? "", err: r.stderr ?? String(r.error ?? "") };
  }

  binary(args: string[], timeoutMs = 30_000): Buffer | null {
    const r = spawnSync(this.bin, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
    return !r.error && r.status === 0 ? (r.stdout as Buffer) : null;
  }

  /** Long-running adb command (e.g. screenrecord); returns the child so it can be stopped. */
  spawn(args: string[]) {
    return spawn(this.bin, args, { stdio: "ignore" });
  }
}

/** Quotes a string for the device's `sh`. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
