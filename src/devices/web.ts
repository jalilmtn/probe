import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { stream } from "../core/proc.js";
import type { Key } from "./android.js";
import type { Driver } from "./driver.js";
import type { UiElement } from "./uitree.js";

// The web target: the deployed app in a Chromium window, driven through Playwright. The engine
// opens the browser with a debugging port; the agent's device tools, which live in another
// process (the MCP server), attach to that same browser and page through the port.

// Playwright is not bundled with Probe (it cannot be, and it brings a browser). These are the
// parts of its API used here.
interface PwPage {
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  goBack(options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  url(): string;
  title(): Promise<string>;
  screenshot(options?: { type?: string }): Promise<Buffer>;
  evaluate<T>(script: string): Promise<T>;
  bringToFront(): Promise<void>;
  isClosed(): boolean;
  waitForLoadState(state?: string, options?: { timeout?: number }): Promise<void>;
  waitForEvent(event: string, options?: { timeout?: number }): Promise<unknown>;
  on(event: string, handler: (arg: never) => void): void;
  video(): { path(): Promise<string> } | null;
  mouse: { click(x: number, y: number, options?: { delay?: number }): Promise<void>; move(x: number, y: number): Promise<void>; wheel(dx: number, dy: number): Promise<void> };
  keyboard: { type(text: string): Promise<void>; press(key: string): Promise<void> };
  viewportSize(): { width: number; height: number } | null;
}
interface PwContext {
  pages(): PwPage[];
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
  on(event: string, handler: (arg: never) => void): void;
}
interface PwBrowser {
  contexts(): PwContext[];
  isConnected(): boolean;
}
interface Playwright {
  chromium: {
    launchPersistentContext(userDataDir: string, options: Record<string, unknown>): Promise<PwContext>;
    connectOverCDP(endpoint: string, options?: { timeout?: number }): Promise<PwBrowser>;
    executablePath(): string;
  };
}

/** Where Probe keeps tools it installs for itself on this machine, outside any project. */
export function toolsDir(): string {
  return join(homedir(), ".probe", "tools");
}

function findPlaywright(projectRoot: string): { pw: Playwright; dir: string } | null {
  // The project's own copy first: a web project often has one, already matched to its browsers.
  for (const dir of [projectRoot, toolsDir()]) {
    try {
      return { pw: createRequire(join(dir, "package.json"))("playwright") as Playwright, dir };
    } catch {
      // Not installed there.
    }
  }
  return null;
}

/** Whether Playwright and its Chromium are on this machine, for the setup checks. */
export function playwrightStatus(projectRoot: string): { installed: boolean; browser: boolean; where?: string } {
  const found = findPlaywright(projectRoot);
  if (!found) return { installed: false, browser: false };
  let browser = false;
  try {
    browser = existsSync(found.pw.chromium.executablePath());
  } catch {
    // A copy too old or broken to name its browser has none we can use.
  }
  return { installed: true, browser, where: found.dir };
}

/**
 * Playwright with a Chromium to drive. The first web run on a machine installs both into
 * Probe's own tools folder (a few minutes, about 150 MB); later runs find them there.
 */
export async function loadPlaywright(projectRoot: string, log: (line: string) => void): Promise<Playwright> {
  let found = findPlaywright(projectRoot);
  if (!found) {
    const dir = toolsDir();
    mkdirSync(dir, { recursive: true });
    if (!existsSync(join(dir, "package.json"))) writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "probe-tools", private: true }, null, 2));
    log("web testing needs Playwright: installing it once for this machine…");
    const code = await stream("npm", ["install", "--no-audit", "--no-fund", "playwright"], dir, log);
    if (code !== 0) throw new Error(`Installing Playwright failed (npm exit ${code}). Run "npm install playwright" in ${dir} to see why.`);
    found = findPlaywright(projectRoot);
    if (!found) throw new Error(`Playwright was installed in ${dir} but cannot be loaded.`);
  }
  if (!existsSync(found.pw.chromium.executablePath())) {
    log("downloading Chromium for Playwright (once, about 150 MB)…");
    // cli.js is not an exported path of the package, so it is found next to its package.json.
    const cli = join(dirname(createRequire(join(found.dir, "package.json")).resolve("playwright/package.json")), "cli.js");
    const code = await stream("node", [cli, "install", "chromium"], found.dir, log);
    if (code !== 0 || !existsSync(found.pw.chromium.executablePath())) throw new Error(`Downloading Chromium failed (exit ${code}). Run "npx playwright install chromium" in ${found.dir} to see why.`);
  }
  return found.pw;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export const WEB_VIEWPORT = { width: 1280, height: 800 };

/** A browser the engine opened for one run. */
export interface WebBrowser {
  /** Where the agent's device tools attach: `http://127.0.0.1:<port>`. */
  endpoint: string;
  label: string;
  /** How long the first page took to load, in ms. */
  loadMs?: number;
  /** Uncaught page errors, console errors and failed requests so far. */
  errors: string[];
  /** Closes the browser; resolves with the recording's file name inside `evidenceDir`, if one was made. */
  close(): Promise<string | undefined>;
}

/** Checks a web app address and returns it normalised. */
export function webUrl(value: string | undefined): string {
  if (!value?.trim()) throw new Error("No web app address. Set it in Studio → Settings → Builds and web.");
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`"${value}" is not a web address (it starts with http:// or https://).`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`"${value}" is not an http(s) address.`);
  return url.toString();
}

/**
 * Opens the web app in Chromium for one run. The profile is kept per project, so a login made
 * in one run is still there in the next, like an app that stays logged in on an emulator.
 */
export async function launchWeb(options: { projectRoot: string; storeDir: string; evidenceDir: string; url: string; log: (line: string) => void }): Promise<WebBrowser> {
  const pw = await loadPlaywright(options.projectRoot, options.log);
  const port = await freePort();
  const headed = process.env.PROBE_WEB_HEADED === "1";
  const context = await pw.chromium.launchPersistentContext(join(options.storeDir, "web-profile"), {
    headless: !headed,
    viewport: WEB_VIEWPORT,
    args: [`--remote-debugging-port=${port}`],
    recordVideo: { dir: options.evidenceDir, size: WEB_VIEWPORT },
  });
  const errors: string[] = [];
  const note = (line: string) => errors.length < 200 && errors.push(line.slice(0, 500));
  const watch = (page: PwPage) => {
    page.on("pageerror", ((e: Error) => note(`page error: ${e.message}`)) as never);
    page.on("console", ((m: { type(): string; text(): string }) => m.type() === "error" && note(`console: ${m.text()}`)) as never);
    page.on("response", ((r: { status(): number; url(): string }) => r.status() >= 500 && note(`HTTP ${r.status()}: ${r.url()}`)) as never);
  };
  context.on("page", watch as never);
  const page = context.pages()[0] ?? (await context.newPage());
  watch(page);
  const browser: WebBrowser = {
    endpoint: `http://127.0.0.1:${port}`,
    label: `Chromium ${WEB_VIEWPORT.width}×${WEB_VIEWPORT.height}${headed ? "" : " (headless)"}`,
    errors,
    async close() {
      const video = page.video();
      await context.close().catch(() => undefined);
      const path = await video?.path().catch(() => undefined);
      if (!path || !existsSync(path)) return undefined;
      renameSync(path, join(options.evidenceDir, "video.webm"));
      return "video.webm";
    },
  };
  try {
    const started = Date.now();
    await page.goto(options.url, { waitUntil: "load", timeout: 60_000 });
    browser.loadMs = Date.now() - started;
  } catch (e) {
    await browser.close();
    throw new Error(`${options.url} did not open: ${(e as Error).message.split("\n")[0]}`);
  }
  return browser;
}

/**
 * Lists what a person could read or use in the window: links, buttons, fields and text, each
 * with where it is. Runs inside the page; elements outside the window or hidden are left out.
 */
const UI_TREE_SCRIPT = `(() => {
  const vw = window.innerWidth, vh = window.innerHeight;
  const ROLES = ["button", "link", "tab", "menuitem", "checkbox", "radio", "switch", "option", "combobox", "textbox", "searchbox"];
  const out = [];
  const all = document.querySelectorAll("body *");
  for (let i = 0; i < all.length && out.length < 220; i++) {
    const el = all[i];
    const tag = el.tagName;
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "TEMPLATE") continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1 || r.bottom <= 0 || r.right <= 0 || r.top >= vh || r.left >= vw) continue;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) continue;
    const role = el.getAttribute("role") || "";
    const input = (tag === "INPUT" && el.type !== "hidden") || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable || role === "textbox" || role === "searchbox";
    const typed = input && !(tag === "INPUT" && ["checkbox", "radio", "button", "submit", "reset", "file", "range", "color"].includes(el.type)) && tag !== "SELECT";
    const click = input || (tag === "A" && el.hasAttribute("href")) || tag === "BUTTON" || tag === "SUMMARY" || ROLES.includes(role) || el.hasAttribute("onclick") || (style.cursor === "pointer" && el.tabIndex >= 0);
    let own = "";
    for (const n of el.childNodes) if (n.nodeType === 3) own += n.textContent;
    own = own.replace(/\\s+/g, " ").trim();
    if (!click && !own) continue;
    // Text inside a link or button is already that element's text.
    if (!click && el.closest("a[href],button,summary,[role=button],[role=link],[role=tab],[role=menuitem]")) continue;
    const x0 = Math.max(0, r.left), y0 = Math.max(0, r.top), x1 = Math.min(vw, r.right), y1 = Math.min(vh, r.bottom);
    const cx = Math.round((x0 + x1) / 2), cy = Math.round((y0 + y1) / 2);
    // Covered by something else (a dialog, a menu): a person could not use it either.
    const top = document.elementFromPoint(cx, cy);
    if (!input && top && !el.contains(top) && !top.contains(el)) continue;
    const password = tag === "INPUT" && el.type === "password";
    let text = click && !input ? (el.innerText || el.value || "") : input ? (password ? "" : tag === "SELECT" ? (el.selectedOptions[0] ? el.selectedOptions[0].text : "") : (el.value || el.innerText || "")) : own;
    text = String(text).replace(/\\s+/g, " ").trim();
    const label = el.labels && el.labels[0] ? el.labels[0].innerText : "";
    const desc = (el.getAttribute("aria-label") || label || el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("alt") || "").replace(/\\s+/g, " ").trim();
    out.push({
      index: 0, text, desc,
      id: el.getAttribute("data-testid") || el.id || el.getAttribute("name") || "",
      cls: role || (tag === "INPUT" ? "input:" + el.type : tag.toLowerCase()),
      clickable: click, input: typed,
      enabled: !el.disabled && el.getAttribute("aria-disabled") !== "true",
      focused: document.activeElement === el,
      checked: el.checked === true || el.getAttribute("aria-checked") === "true" || el.getAttribute("aria-selected") === "true",
      scrollable: false, password,
      center: [cx, cy], bounds: [Math.round(x0), Math.round(y0), Math.round(x1), Math.round(y1)],
    });
  }
  out.forEach((e, i) => (e.index = i + 1));
  return out;
})()`;

const KEYS: Partial<Record<Key, string>> = { enter: "Enter", tab: "Tab", delete: "Backspace" };

/** Browsers this process has attached to, by endpoint: one agent's tool calls reuse the connection. */
const attached = new Map<string, Promise<PwBrowser>>();

/** The web app's page, as an agent's device tools see it. Attaches to the browser the engine opened. */
export class WebDevice implements Driver {
  lastTree: UiElement[] = [];

  constructor(
    private readonly projectRoot: string,
    private readonly endpoint: string,
    private readonly baseUrl: string,
  ) {}

  private async browser(): Promise<PwBrowser> {
    let pending = attached.get(this.endpoint);
    if (pending && !(await pending.catch(() => null))?.isConnected()) pending = undefined;
    if (!pending) {
      const found = findPlaywright(this.projectRoot);
      if (!found) throw new Error("Playwright is not installed on this machine.");
      pending = found.pw.chromium.connectOverCDP(this.endpoint, { timeout: 20_000 });
      attached.set(this.endpoint, pending);
    }
    try {
      return await pending;
    } catch (e) {
      attached.delete(this.endpoint);
      throw new Error(`The run's browser is not reachable (${(e as Error).message.split("\n")[0]}).`);
    }
  }

  /** The page the person would be looking at: the newest tab still open. */
  private async page(): Promise<PwPage> {
    const pages = (await this.browser()).contexts().flatMap((c) => c.pages()).filter((p) => !p.isClosed());
    const page = pages[pages.length - 1];
    if (!page) throw new Error("The browser has no open page.");
    return page;
  }

  /** Waits for the page to be readable: a document that has finished parsing. */
  private async settle(page: PwPage): Promise<void> {
    await page.waitForLoadState("domcontentloaded", { timeout: 8_000 }).catch(() => undefined);
  }

  /**
   * After a click or key that may leave the page: gives a navigation a moment to start, then
   * waits for the new page. Without the pause the old page still counts as loaded, and the
   * next action would land in the middle of the move.
   */
  private async afterAction(page: PwPage): Promise<void> {
    await page.waitForEvent("framenavigated", { timeout: 900 }).catch(() => undefined);
    await this.settle(page);
  }

  /** Goes to an address; a move already under way (a click just before) is let finish first, once. */
  private async go(page: PwPage, url: string): Promise<void> {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    } catch (e) {
      if (!/interrupted by another navigation/.test((e as Error).message)) throw new Error(`${url} did not open: ${(e as Error).message.split("\n")[0]}`);
      await this.settle(page);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    }
  }

  async screenshot(): Promise<Buffer | null> {
    return (await this.page()).screenshot({ type: "png" }).catch(() => null);
  }

  async uiTree(): Promise<UiElement[]> {
    const page = await this.page();
    await this.settle(page);
    this.lastTree = await page.evaluate<UiElement[]>(UI_TREE_SCRIPT).catch(() => []);
    return this.lastTree;
  }

  /** Where the page is, for the top of an observe. */
  async location(): Promise<string> {
    const page = await this.page();
    return `${await page.title().catch(() => "")} · ${page.url()}`;
  }

  async tap(target: { element?: number; x?: number; y?: number }): Promise<string> {
    let x = target.x;
    let y = target.y;
    if (target.element !== undefined) {
      const el = this.lastTree.find((e) => e.index === target.element);
      if (!el) throw new Error(`No element [${target.element}] on the last observed page; observe again.`);
      [x, y] = el.center;
    }
    if (x === undefined || y === undefined) throw new Error("tap needs an element number or x and y");
    const page = await this.page();
    await page.mouse.click(x, y);
    await this.afterAction(page);
    return `clicked ${x},${y}`;
  }

  async longPress(x: number, y: number): Promise<void> {
    await (await this.page()).mouse.click(x, y, { delay: 800 });
  }

  async type(text: string): Promise<void> {
    await (await this.page()).keyboard.type(text);
  }

  async key(key: Key): Promise<void> {
    const page = await this.page();
    if (key === "back") await page.goBack({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => undefined);
    else if (key === "home") await this.go(page, this.baseUrl);
    else if (KEYS[key]) {
      await page.keyboard.press(KEYS[key]);
      // Enter can submit a form and leave the page.
      if (key === "enter") await this.afterAction(page);
    } else throw new Error(`The ${key} key does nothing in a browser.`);
    await this.settle(page);
  }

  /** Swiping up moves the content up, as on a phone: the page scrolls down. */
  async swipe(direction: "up" | "down" | "left" | "right"): Promise<void> {
    const page = await this.page();
    const size = page.viewportSize() ?? WEB_VIEWPORT;
    await page.mouse.move(size.width / 2, size.height / 2);
    const far = Math.round(size.height * 0.7);
    const [dx, dy] = { up: [0, far], down: [0, -far], left: [far, 0], right: [-far, 0] }[direction] as [number, number];
    await page.mouse.wheel(dx, dy);
  }

  async relaunch(): Promise<void> {
    await this.go(await this.page(), this.baseUrl);
  }

  /** Goes to a path or address of the site under test; other sites are refused. */
  async open(url: string): Promise<string> {
    const next = new URL(url, this.baseUrl);
    if (next.origin !== new URL(this.baseUrl).origin) throw new Error(`${next.origin} is not the site under test (${new URL(this.baseUrl).origin}).`);
    await this.go(await this.page(), next.toString());
    return next.toString();
  }
}
