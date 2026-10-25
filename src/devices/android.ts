import { Adb, shQuote } from "./adb.js";
import { parseUiTree, type UiElement } from "./uitree.js";

export interface DeviceInfo {
  serial: string;
  model: string;
  emulator: boolean;
}

export type Key = "back" | "home" | "enter" | "tab" | "delete" | "app_switch";

const KEYCODES: Record<Key, string> = {
  back: "KEYCODE_BACK",
  home: "KEYCODE_HOME",
  enter: "KEYCODE_ENTER",
  tab: "KEYCODE_TAB",
  delete: "KEYCODE_DEL",
  app_switch: "KEYCODE_APP_SWITCH",
};

export function listDevices(adb: Adb): DeviceInfo[] {
  const r = adb.run(["devices", "-l"]);
  if (!r.ok) return [];
  return r.out
    .split("\n")
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p[1] === "device")
    .map((p) => ({
      serial: p[0]!,
      model: (p.find((x) => x.startsWith("model:")) ?? "model:?").slice(6),
      emulator: p[0]!.startsWith("emulator-"),
    }));
}

/** Everything Probe does to one Android device. Stateless apart from the last UI dump. */
export class AndroidDevice {
  /** What element numbers in tap refer to. A session restores it, since each tool call is a new device. */
  lastTree: UiElement[] = [];

  constructor(
    readonly adb: Adb,
    readonly serial: string,
  ) {}

  private shell(cmd: string, timeoutMs?: number) {
    return this.adb.run(["-s", this.serial, "shell", cmd], timeoutMs);
  }

  screenshot(): Buffer | null {
    return this.adb.binary(["-s", this.serial, "exec-out", "screencap", "-p"]);
  }

  /** Dumps the accessibility tree. Retries once: dumps fail while the screen is animating. */
  uiTree(): UiElement[] {
    for (let attempt = 0; attempt < 2; attempt++) {
      const dump = this.shell("uiautomator dump /sdcard/probe-ui.xml >/dev/null && cat /sdcard/probe-ui.xml", 20_000);
      if (dump.ok && dump.out.includes("<hierarchy")) {
        this.lastTree = parseUiTree(dump.out);
        return this.lastTree;
      }
    }
    this.lastTree = [];
    return [];
  }

  /** Taps an element from the last `uiTree()` by its number, or a raw coordinate. */
  tap(target: { element?: number; x?: number; y?: number }): string {
    let x = target.x;
    let y = target.y;
    if (target.element !== undefined) {
      const el = this.lastTree.find((e) => e.index === target.element);
      if (!el) throw new Error(`No element [${target.element}] on the last observed screen; observe again.`);
      [x, y] = el.center;
    }
    if (x === undefined || y === undefined) throw new Error("tap needs an element number or x and y");
    this.shell(`input tap ${Math.round(x)} ${Math.round(y)}`);
    return `tapped ${x},${y}`;
  }

  longPress(x: number, y: number, ms = 800): void {
    this.shell(`input swipe ${x} ${y} ${x} ${y} ${ms}`);
  }

  /** Types into the focused field. `input text` needs spaces as %s. */
  type(text: string): void {
    this.shell(`input text ${shQuote(text.replace(/%/g, "\\%").replace(/ /g, "%s"))}`);
  }

  key(key: Key): void {
    this.shell(`input keyevent ${KEYCODES[key]}`);
  }

  swipe(direction: "up" | "down" | "left" | "right"): void {
    const size = /(\d+)x(\d+)/.exec(this.shell("wm size").out);
    const w = Number(size?.[1] ?? 1080);
    const h = Number(size?.[2] ?? 2400);
    const [cx, cy] = [Math.round(w / 2), Math.round(h / 2)];
    const d = { up: [cx, h * 0.75, cx, h * 0.25], down: [cx, h * 0.25, cx, h * 0.75], left: [w * 0.85, cy, w * 0.15, cy], right: [w * 0.15, cy, w * 0.85, cy] }[direction];
    this.shell(`input swipe ${d.map(Math.round).join(" ")} 300`);
  }

  isInstalled(pkg: string): boolean {
    return this.shell(`pm path ${pkg}`).out.includes("package:");
  }

  launch(pkg: string): void {
    this.shell(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`);
  }

  /**
   * Cold-starts the launcher activity and returns Android's own start time (TotalTime), or
   * undefined when the activity could not be resolved and the app was started without timing.
   */
  launchTimed(pkg: string): number | undefined {
    // An app can have several launchers (debug tools such as LeakCanary add one); resolving
    // then returns the system chooser, so pick the app's own from the full list.
    const launchers = this.shell(`cmd package query-activities --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER ${pkg}`)
      .out.split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith(`${pkg}/`));
    const activity = launchers.find((l) => !/leakcanary|chucker|flipper|debug\.?drawer/i.test(l)) ?? launchers[0];
    if (!activity) {
      this.launch(pkg);
      return undefined;
    }
    const total = /TotalTime:\s*(\d+)/.exec(this.shell(`am start -W -n ${activity}`, 30_000).out);
    return total ? Number(total[1]) : undefined;
  }

  /** Zeroes the frame counters, so a later `frameStats` covers only what happens after. */
  resetFrameStats(pkg: string): void {
    this.shell(`dumpsys gfxinfo ${pkg} reset`);
  }

  /** Frames rendered since the last reset, from `dumpsys gfxinfo`. */
  frameStats(pkg: string): { frames: number; jankyPct: number; p50Ms: number; p90Ms: number; p99Ms: number } | null {
    const out = this.shell(`dumpsys gfxinfo ${pkg}`, 20_000).out;
    const num = (re: RegExp) => Number(re.exec(out)?.[1] ?? NaN);
    const frames = num(/Total frames rendered:\s*(\d+)/);
    if (!Number.isFinite(frames)) return null;
    return {
      frames,
      jankyPct: num(/Janky frames:\s*\d+\s*\(([\d.]+)%\)/) || 0,
      p50Ms: num(/50th percentile:\s*(\d+)ms/) || 0,
      p90Ms: num(/90th percentile:\s*(\d+)ms/) || 0,
      p99Ms: num(/99th percentile:\s*(\d+)ms/) || 0,
    };
  }

  /** Total PSS of the app's process, in MB. */
  memoryMb(pkg: string): number | undefined {
    const out = this.shell(`dumpsys meminfo ${pkg}`, 20_000).out;
    const kb = /TOTAL PSS:\s*(\d+)/.exec(out) ?? /TOTAL\s+(\d+)/.exec(out);
    return kb ? Math.round(Number(kb[1]) / 1024) : undefined;
  }

  stop(pkg: string): void {
    this.shell(`am force-stop ${pkg}`);
  }

  /** Device clock, so logcat can be read from the start of a run. */
  now(): string {
    return this.shell("date '+%m-%d %H:%M:%S.000'").out.trim();
  }

  clearLogcat(): void {
    this.adb.run(["-s", this.serial, "logcat", "-c"]);
  }

  /** Crash and ANR reports for `pkg` since the log was last cleared. */
  crashes(pkg: string): string[] {
    const r = this.adb.run(["-s", this.serial, "logcat", "-d", "-b", "crash", "-b", "main", "-v", "brief"], 30_000);
    const lines = r.out.split("\n");
    const out: string[] = [];
    lines.forEach((line, i) => {
      if ((/FATAL EXCEPTION/.test(line) && lines.slice(i, i + 3).some((l) => l.includes(pkg))) || (/ANR in /.test(line) && line.includes(pkg))) {
        out.push(lines.slice(i, i + 8).join("\n"));
      }
    });
    return out;
  }

  /**
   * Records the screen (Android caps one recording at 3 minutes). The returned function
   * stops it and pulls the file to `destination`, resolving false when nothing was saved.
   */
  startRecording(): (destination: string) => Promise<boolean> {
    const remote = "/sdcard/probe-run.mp4";
    const child = this.adb.spawn(["-s", this.serial, "shell", "screenrecord", "--time-limit", "180", remote]);
    return async (destination) => {
      // SIGINT lets screenrecord finish the file; killing adb alone leaves it corrupt.
      this.shell("pkill -INT screenrecord");
      await new Promise((r) => setTimeout(r, 1_500));
      child.kill();
      const pulled = this.adb.run(["-s", this.serial, "pull", remote, destination], 60_000).ok;
      this.shell(`rm -f ${remote}`);
      return pulled;
    };
  }

  isBooted(): boolean {
    return this.shell("getprop sys.boot_completed").out.trim() === "1";
  }
}
