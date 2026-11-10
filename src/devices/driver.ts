import { devicesUnsupported } from "../adapters/adapter.js";
import type { RunTarget } from "../core/types.js";
import type { Project } from "../engine/project.js";
import type { Key } from "./android.js";
import type { UiElement } from "./uitree.js";

type MaybePromise<T> = T | Promise<T>;

/**
 * What an agent's device tools need from whatever shows the app: an Android device over adb,
 * or a browser page. The Android driver answers at once, the browser one asynchronously.
 */
export interface Driver {
  /** What element numbers in `tap` refer to: the list from the last `uiTree()`. */
  lastTree: UiElement[];
  screenshot(): MaybePromise<Buffer | null>;
  uiTree(): MaybePromise<UiElement[]>;
  tap(target: { element?: number; x?: number; y?: number }): MaybePromise<string>;
  longPress(x: number, y: number): MaybePromise<void>;
  type(text: string): MaybePromise<void>;
  key(key: Key): MaybePromise<void>;
  swipe(direction: "up" | "down" | "left" | "right"): MaybePromise<void>;
  /** Starts the app again from its first screen. */
  relaunch(app: string): MaybePromise<void>;
  /** Web only: goes to a path or address of the site under test. */
  open?(url: string): Promise<string>;
}

/** The targets agents can test on in this project: Android when it builds an app, web when a URL is set. */
export function runTargets(project: Project): RunTarget[] {
  const out: RunTarget[] = [];
  if (project.adapter.supportsDevices) out.push("android");
  if (project.config.web?.url) out.push("web");
  return out;
}

/** The target a run uses: the one asked for, else the project's first. */
export function pickTarget(project: Project, wanted?: RunTarget): RunTarget {
  const targets = runTargets(project);
  if (wanted) {
    if (targets.includes(wanted)) return wanted;
    throw new Error(wanted === "web" ? "No web app address. Set it in Studio → Settings → Builds and web." : devicesUnsupported(project.adapter));
  }
  if (!targets.length) throw new Error(`${devicesUnsupported(project.adapter)} To test a web app in a browser, set its address in Studio → Settings → Builds and web.`);
  return targets[0]!;
}
