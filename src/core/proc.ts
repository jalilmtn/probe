import { AsyncLocalStorage } from "node:async_hooks";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

export const isWindows = process.platform === "win32";

/** Runs a short command and returns its trimmed stdout, or null if it failed to start or exited non-zero. */
export function capture(cmd: string, args: string[], cwd?: string): string | null {
  const res = spawnSync(cmd, args, { cwd, encoding: "utf8", shell: isWindows, windowsHide: true, timeout: 20_000 });
  if (res.error || res.status !== 0) return null;
  return `${res.stdout ?? ""}`.trim();
}

/** The stop signal of the run whose work is executing; every stream() under it is killed on stop. */
export const runSignal = new AsyncLocalStorage<AbortSignal>();

export class StoppedError extends Error {
  constructor() {
    super("Stopped.");
  }
}

/** Throws at a safe point between steps once the current run has been stopped. */
export function throwIfStopped(): void {
  if (runSignal.getStore()?.aborted) throw new StoppedError();
}

/** Kills a process and everything it started: on Windows the shell's children (gradle, claude) outlive the shell. */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (isWindows) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  else child.kill("SIGTERM");
}

export interface StreamOptions {
  /** Written to stdin, which is then closed. */
  input?: string;
  env?: NodeJS.ProcessEnv;
}

/** Streams a long command line by line (stdout and stderr). Resolves with the exit code. */
export function stream(
  cmd: string,
  args: string[],
  cwd: string,
  onLine: (line: string) => void,
  options: StreamOptions = {},
): Promise<number> {
  const signal = runSignal.getStore();
  if (signal?.aborted) return Promise.reject(new StoppedError());
  return new Promise((resolvePromise, reject) => {
    // With a shell (Windows, for .bat/.cmd shims) arguments are joined, so quote the ones that need it.
    const finalArgs = isWindows ? args.map(quoteForCmd) : args;
    const child = spawn(cmd, finalArgs, { cwd, shell: isWindows, windowsHide: true, env: options.env ?? process.env });
    child.stdin.end(options.input ?? "");
    const pipe = (chunkStream: NodeJS.ReadableStream) => {
      let buffer = "";
      chunkStream.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        lines.forEach(onLine);
      });
      chunkStream.on("end", () => buffer && onLine(buffer));
    };
    pipe(child.stdout);
    pipe(child.stderr);
    const onAbort = () => killTree(child);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", reject);
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) reject(new StoppedError());
      else resolvePromise(code ?? 1);
    });
  });
}

function quoteForCmd(arg: string): string {
  return /[\s"&|<>^()]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

export function openInBrowser(url: string): void {
  const [cmd, args] = isWindows
    ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin"
      ? ["open", [url]]
      : ["xdg-open", [url]];
  spawn(cmd, args as string[], { detached: true, stdio: "ignore", windowsHide: true }).unref();
}
