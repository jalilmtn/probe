import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CardVerdict, TimelineEntry } from "../core/types.js";
import { Adb } from "./adb.js";
import { AndroidDevice } from "./android.js";
import type { UiElement } from "./uitree.js";

/**
 * One agent's hold on one device for one run. The engine creates it; the MCP server (a
 * separate process, started by the agent) finds it through PROBE_SESSION and writes every
 * action and screenshot into the run's evidence folder.
 */
export interface SessionInfo {
  id: string;
  projectRoot: string;
  serial: string;
  appPackage: string;
  evidenceDir: string;
}

export function sessionFile(storeDir: string, id: string): string {
  return join(storeDir, "sessions", `${id}.json`);
}

export function createSession(storeDir: string, info: Omit<SessionInfo, "evidenceDir">): SessionInfo {
  const session: SessionInfo = { ...info, evidenceDir: join(storeDir, "runs", info.id) };
  mkdirSync(join(storeDir, "sessions"), { recursive: true });
  mkdirSync(session.evidenceDir, { recursive: true });
  writeFileSync(sessionFile(storeDir, info.id), JSON.stringify(session, null, 2));
  return session;
}

export class DeviceSession {
  readonly device: AndroidDevice;
  private step = 0;

  constructor(readonly info: SessionInfo) {
    this.device = new AndroidDevice(Adb.forProject(info.projectRoot), info.serial);
    this.step = this.timeline().length;
    const tree = join(info.evidenceDir, "last-tree.json");
    if (existsSync(tree)) this.device.lastTree = JSON.parse(readFileSync(tree, "utf8")) as UiElement[];
  }

  /**
   * Dumps the screen's elements and keeps them in the run folder: the MCP server handles every
   * tool call on a fresh session, so an element number from observe must survive until act.
   */
  observe(): UiElement[] {
    const elements = this.device.uiTree();
    writeFileSync(join(this.info.evidenceDir, "last-tree.json"), JSON.stringify(elements));
    return elements;
  }

  static open(storeDir: string, id: string): DeviceSession {
    const file = sessionFile(storeDir, id);
    if (!existsSync(file)) throw new Error(`No device session "${id}". Agent device tools only work inside a Probe card run.`);
    return new DeviceSession(JSON.parse(readFileSync(file, "utf8")) as SessionInfo);
  }

  /** Saves a screenshot as the next step's evidence and returns it. */
  capture(): { png: Buffer; name: string } | null {
    const png = this.device.screenshot();
    if (!png) return null;
    const name = `step-${String(this.step + 1).padStart(3, "0")}.png`;
    writeFileSync(join(this.info.evidenceDir, name), png);
    return { png, name };
  }

  record(action: string, detail: string, screenshot?: string): void {
    this.step++;
    const entry: TimelineEntry = { at: new Date().toISOString(), action, detail, screenshot };
    appendFileSync(join(this.info.evidenceDir, "timeline.jsonl"), `${JSON.stringify(entry)}\n`);
  }

  timeline(): TimelineEntry[] {
    const file = join(this.info.evidenceDir, "timeline.jsonl");
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as TimelineEntry);
  }

  /** What the agent's report tool handed in (verdict, login state, explored screens). */
  saveReport(name: "verdict" | "login" | "explore", value: unknown): void {
    writeFileSync(join(this.info.evidenceDir, `${name}.json`), JSON.stringify(value, null, 2));
  }

  report<T>(name: "verdict" | "login" | "explore"): T | null {
    const file = join(this.info.evidenceDir, `${name}.json`);
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : null;
  }

  saveVerdict(verdict: CardVerdict): void {
    this.saveReport("verdict", verdict);
  }

  verdict(): CardVerdict | null {
    return this.report<CardVerdict>("verdict");
  }
}
