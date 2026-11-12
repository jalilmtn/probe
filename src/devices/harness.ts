import { join } from "node:path";
import { runAgent } from "../agent/headless.js";
import { throwIfStopped } from "../core/proc.js";
import type { ProbeConfig } from "../core/config.js";
import type { BuildRef, DeviceRun, PerfReport, RunTarget } from "../core/types.js";
import { resolveApp } from "../engine/app.js";
import type { Project } from "../engine/project.js";
import { alreadyInstalled, installBuild, resolveBuild } from "./builds.js";
import { pickTarget } from "./driver.js";
import { createSession, DeviceSession } from "./session.js";
import { pickDevice } from "./select.js";
import { launchWeb, webUrl } from "./web.js";

/** Tools every device agent gets; each run kind adds the one it reports through. */
export const DEVICE_TOOLS = ["probe_device_observe", "probe_device_act", "probe_device_type_secret"];

const SAFETY = (outside: string) => `## Safety — stop and report "blocked" instead of guessing
- The app is logged in with an account that is not one of the test accounts: do not post, send, edit, delete, like or follow anything. Every account listed under Test accounts is a test account: it is one when the app shows its username, its email or its "shown in the app as" name. A name shown in the app can be out of date, so when the profile shows a handle that matches none of them, open the account or settings screen and look for the email or username before you decide; only an account that matches no test account by any of these is not one.
- A login needs something you do not have (an SMS or email code that is not stored, a captcha, 2FA).
- A sign-in is refused (an error on the fields, "wrong password", the same screen back): do not try again or try test accounts the task does not name. Stop at once and report blocked, saying what the app showed.
- Before you tap sign in, look at the fields: autofill or a saved-account picker can replace what you typed with another account. If a field does not show exactly the test account, clear it and type it again; never sign in with an account the task does not name.
- Never buy, pay, change account or privacy settings, or touch anything outside this ${outside}.
- Only create or delete content with a test account, and only what the task needs.`;

/** How an agent drives the screen of an Android device. */
export const DEVICE_HOW_TO = `## How to work
- Look before you act: call probe_device_observe, which returns a screenshot and a numbered list of on-screen elements. Observe again after every action that changes the screen.
- Act with probe_device_act: tap an element by its number from the last observe (prefer that over coordinates), type into the focused field, press keys, swipe, wait for loading.
- To log in: tap the username field and type the username yourself; for the password or a login code, tap the field and call probe_device_type_secret with the account role. You never see passwords.
- Lists: scroll them a few times (swipe up, then back down). Probe measures frame times, so scrolling and transitions are part of the test.

${SAFETY("app")}`;

/** How an agent drives the web app in a browser window, with the same tools. */
export const WEB_HOW_TO = `## How to work
- Look before you act: call probe_device_observe, which returns a screenshot of the browser window, the page's address, and a numbered list of the elements in view. Observe again after every action that changes the page.
- Act with probe_device_act: tap clicks an element by its number from the last observe (prefer that over coordinates); type goes into the focused field, so tap the field first; key presses enter, tab or delete, back is the browser's back button and home returns to the app's start page; swipe up scrolls the page down and swipe down scrolls it up; wait for loading.
- Only what is inside the window is listed: scroll to find the rest of a page.
- To go straight to a page of this site, use action open with url set to its path, e.g. "/settings". Other sites are refused.
- To log in: tap the username field and type the username yourself; for the password or a login code, tap the field and call probe_device_type_secret with the account role. You never see passwords.

${SAFETY("site")}`;

/** The working instructions for a target. */
export function howTo(target: RunTarget): string {
  return target === "web" ? WEB_HOW_TO : DEVICE_HOW_TO;
}

/** "the Android app com.x on emulator-5554 (Pixel)" or "the web app at https://… in Chromium", for a prompt's first line. */
export function appOn(target: RunTarget, device: string, app: string): string {
  return target === "web" ? `the web app at ${app} in ${device}` : `the Android app ${app} on ${device}`;
}

export interface HarnessOptions {
  device?: string;
  model?: string;
  /** Android or web; unset means the project's first target. */
  target?: RunTarget;
  /** A finished build to test instead of the working tree (Android). */
  build?: BuildRef;
  /** "always" reinstalls from the current code (verify); "missing" only when not installed. */
  install?: "missing" | "always";
  prompt: (deviceLabel: string, app: string, target: RunTarget) => string;
  /** Report tool(s) of this run kind, on top of DEVICE_TOOLS. */
  reportTools: string[];
}

/**
 * Runs one agent against the app and fills the fields every such run shares: device, timeline,
 * screenshots, recording, crashes, performance and cost. On Android the app runs on an
 * emulator or phone; on web, in a browser. Returns the session so the caller can read what its
 * report tool saved.
 */
export async function runOnDevice(project: Project, run: DeviceRun, options: HarnessOptions, log: (line: string) => void): Promise<DeviceSession> {
  const target = pickTarget(project, options.target);
  run.target = target;
  if (target === "web") {
    if (options.build) throw new Error("A build is an Android build; the web app is tested at its address.");
    return runInBrowser(project, run, options, log);
  }
  return runOnAndroid(project, run, options, log);
}

async function runInBrowser(project: Project, run: DeviceRun, options: HarnessOptions, log: (line: string) => void): Promise<DeviceSession> {
  const url = webUrl(project.config.web.url);
  const info = createSession(project.store.dir, { id: run.id, projectRoot: project.root, serial: "browser", appPackage: url, target: "web" });
  const browser = await launchWeb({ projectRoot: project.root, storeDir: project.store.dir, evidenceDir: info.evidenceDir, url, log });
  run.device = browser.label;
  log(`browser: ${run.device}`);
  log(`web app: ${url}${browser.loadMs !== undefined ? ` · loaded in ${browser.loadMs} ms` : ""}`);
  // The agent's tools run in another process: they find the browser through the session file.
  const session = new DeviceSession(createSession(project.store.dir, { ...info, endpoint: browser.endpoint }));
  try {
    throwIfStopped();
    const result = await runAgent(
      project,
      { prompt: options.prompt(run.device, url, "web"), probeTools: [...DEVICE_TOOLS, ...options.reportTools], builtinTools: [], model: options.model, mcpEnv: { PROBE_SESSION: run.id } },
      log,
    );
    run.costUsd += result.costUsd;
    if (!result.ok) log(`agent: ${result.summary.slice(0, 300)}`);
  } finally {
    const video = await browser.close();
    if (video) run.video = video;
  }
  run.timeline = session.timeline();
  run.webErrors = [...new Set(browser.errors)];
  if (run.webErrors.length) log(`page errors: ${run.webErrors.length} (shown with the run; they do not fail it on their own)`);
  return session;
}

async function runOnAndroid(project: Project, run: DeviceRun, options: HarnessOptions, log: (line: string) => void): Promise<DeviceSession> {
  let app = resolveApp(project);
  if (!options.build && !app.package && !app.installTask) throw new Error("Probe could not find the app this project builds. Set it in Studio → Settings → Project.");

  const { device, info } = await pickDevice(project.root, project.config, options.device, log);
  run.device = `${info.serial} (${info.model})`;
  log(`device: ${run.device}`);

  const install = options.install ?? "missing";
  let pkg: string;
  if (options.build) {
    // A finished build: what is on the device must be exactly it, whatever the working tree holds.
    const build = await resolveBuild(project, options.build, log);
    run.build = build.tested;
    throwIfStopped();
    if (install !== "always" && alreadyInstalled(device, build)) {
      pkg = build.tested.package!;
      log(`build: ${build.tested.label}, already on the device`);
    } else {
      pkg = installBuild(project, device, build, log);
      run.build = { ...build.tested, package: pkg, versionCode: build.tested.versionCode ?? device.versionCode(pkg) };
      log(`build: ${run.build.label}`);
    }
    log(`app: ${pkg}`);
  } else {
    // An unknown package (id from secrets, never built) becomes known once the build has run.
    if (install === "always" || !app.package || !device.isInstalled(app.package)) {
      const task = app.installTask;
      if (!task) {
        if (install === "always" && device.isInstalled(app.package!)) log(`No install task: testing the ${app.package} already installed, which may not be this code.`);
        else throw new Error(`${app.package} is not installed on ${info.serial}. Set the install task in Studio → Settings → Project.`);
      } else {
        const code = await project.adapter.installApp(project.root, task, info.serial, log);
        app = resolveApp(project);
        if (code !== 0) throw new Error(`Installing the app with ${task} failed (exit ${code}).`);
        if (!app.package) throw new Error(`${task} succeeded but Probe cannot tell the app's id. Set it in Studio → Settings → Project.`);
        if (!device.isInstalled(app.package)) throw new Error(`${task} finished but ${app.package} is not on ${info.serial}.`);
      }
    }
    pkg = app.package!;
    log(`app: ${pkg}${app.packageSource === "probe.yaml" ? "" : ` (detected from the ${app.packageSource})`}`);
  }

  device.clearLogcat();
  device.stop(pkg);
  const startupMs = device.launchTimed(pkg);
  if (startupMs !== undefined) log(`cold start: ${startupMs} ms`);
  await new Promise((r) => setTimeout(r, 2_500));
  device.resetFrameStats(pkg);
  throwIfStopped();

  const session = new DeviceSession(createSession(project.store.dir, { id: run.id, projectRoot: project.root, serial: info.serial, appPackage: pkg, target: "android" }));
  const stopRecording = device.startRecording();
  try {
    const result = await runAgent(
      project,
      { prompt: options.prompt(run.device, pkg, "android"), probeTools: [...DEVICE_TOOLS, ...options.reportTools], builtinTools: [], model: options.model, mcpEnv: { PROBE_SESSION: run.id } },
      log,
    );
    run.costUsd += result.costUsd;
    if (!result.ok) log(`agent: ${result.summary.slice(0, 300)}`);
  } finally {
    if (await stopRecording(join(session.info.evidenceDir, "video.mp4"))) run.video = "video.mp4";
  }

  run.timeline = session.timeline();
  run.crashes = device.crashes(pkg);
  const frames = device.frameStats(pkg);
  if (frames) {
    run.perf = { startupMs, ...frames, memoryMb: device.memoryMb(pkg), issues: [] };
    run.perf.issues = perfIssues(run.perf, project.config.perf);
    log(`perf: ${frames.frames} frames · ${frames.jankyPct}% janky · p90 ${frames.p90Ms} ms${run.perf.memoryMb ? ` · ${run.perf.memoryMb} MB` : ""}`);
    for (const issue of run.perf.issues) log(`perf warning: ${issue}`);
  }
  if (run.crashes.length) log(`crashes: ${run.crashes.length}`);
  return session;
}

export function perfIssues(perf: PerfReport, limits: ProbeConfig["perf"]): string[] {
  const out: string[] = [];
  if (perf.startupMs !== undefined && perf.startupMs > limits.maxStartupMs) out.push(`cold start ${perf.startupMs} ms (limit ${limits.maxStartupMs})`);
  // Too few frames say nothing about smoothness.
  if (perf.frames >= 30 && perf.jankyPct > limits.maxJankyPct) out.push(`${perf.jankyPct}% janky frames (limit ${limits.maxJankyPct}%)`);
  if (perf.frames >= 30 && perf.p90Ms > limits.maxP90Ms) out.push(`90th percentile frame ${perf.p90Ms} ms (limit ${limits.maxP90Ms})`);
  if (limits.maxMemoryMb && perf.memoryMb && perf.memoryMb > limits.maxMemoryMb) out.push(`${perf.memoryMb} MB memory (limit ${limits.maxMemoryMb})`);
  return out;
}

/** A crash in logcat fails a device run whatever the agent concluded. */
export function crashError(run: DeviceRun): string | undefined {
  return run.crashes.length ? `The app crashed during the run (${run.crashes.length} report${run.crashes.length > 1 ? "s" : ""} in logcat).` : undefined;
}
