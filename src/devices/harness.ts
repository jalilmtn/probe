import { join } from "node:path";
import { runAgent } from "../agent/headless.js";
import { throwIfStopped } from "../core/proc.js";
import type { ProbeConfig } from "../core/config.js";
import type { DeviceRun, PerfReport } from "../core/types.js";
import { resolveApp } from "../engine/app.js";
import type { Project } from "../engine/project.js";
import { createSession, DeviceSession } from "./session.js";
import { pickDevice } from "./select.js";

/** Tools every device agent gets; each run kind adds the one it reports through. */
export const DEVICE_TOOLS = ["probe_device_observe", "probe_device_act", "probe_device_type_secret"];

/** How an agent drives the screen. Shared by every device prompt. */
export const DEVICE_HOW_TO = `## How to work
- Look before you act: call probe_device_observe, which returns a screenshot and a numbered list of on-screen elements. Observe again after every action that changes the screen.
- Act with probe_device_act: tap an element by its number from the last observe (prefer that over coordinates), type into the focused field, press keys, swipe, wait for loading.
- To log in: tap the username field and type the username yourself; for the password or a login code, tap the field and call probe_device_type_secret with the account role. You never see passwords.
- Lists: scroll them a few times (swipe up, then back down). Probe measures frame times, so scrolling and transitions are part of the test.

## Safety — stop and report "blocked" instead of guessing
- The app is logged in with an account that is not one of the test accounts: do not post, send, edit, delete, like or follow anything.
- A login needs something you do not have (an SMS or email code that is not stored, a captcha, 2FA).
- Never buy, pay, change account or privacy settings, or touch anything outside this app.
- Only create or delete content with a test account, and only what the task needs.`;

export interface HarnessOptions {
  device?: string;
  model?: string;
  /** "always" reinstalls from the current code (verify); "missing" only when not installed. */
  install?: "missing" | "always";
  prompt: (deviceLabel: string, appPackage: string) => string;
  /** Report tool(s) of this run kind, on top of DEVICE_TOOLS. */
  reportTools: string[];
}

/**
 * Runs one agent against the app on a device and fills the fields every device run shares:
 * device, timeline, screenshots, recording, crashes, performance and cost. Returns the
 * session so the caller can read what its report tool saved.
 */
export async function runOnDevice(project: Project, run: DeviceRun, options: HarnessOptions, log: (line: string) => void): Promise<DeviceSession> {
  let app = resolveApp(project);
  if (!app.package && !app.installTask) throw new Error("Probe could not find the app this project builds. Set it in Studio → Settings → Project.");

  const { device, info } = await pickDevice(project.root, project.config, options.device, log);
  run.device = `${info.serial} (${info.model})`;
  log(`device: ${run.device}`);

  // An unknown package (id from secrets, never built) becomes known once the build has run.
  const install = options.install ?? "missing";
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
  const pkg = app.package!;
  log(`app: ${pkg}${app.packageSource === "probe.yaml" ? "" : ` (detected from the ${app.packageSource})`}`);

  device.clearLogcat();
  device.stop(pkg);
  const startupMs = device.launchTimed(pkg);
  if (startupMs !== undefined) log(`cold start: ${startupMs} ms`);
  await new Promise((r) => setTimeout(r, 2_500));
  device.resetFrameStats(pkg);
  throwIfStopped();

  const session = new DeviceSession(createSession(project.store.dir, { id: run.id, projectRoot: project.root, serial: info.serial, appPackage: pkg }));
  const stopRecording = device.startRecording();
  try {
    const result = await runAgent(
      project,
      { prompt: options.prompt(run.device, pkg), probeTools: [...DEVICE_TOOLS, ...options.reportTools], builtinTools: [], model: options.model, mcpEnv: { PROBE_SESSION: run.id } },
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
