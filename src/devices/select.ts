import { spawn, spawnSync } from "node:child_process";
import type { ProbeConfig } from "../core/config.js";
import { throwIfStopped } from "../core/proc.js";
import { Adb, sdkTool } from "./adb.js";
import { AndroidDevice, listDevices, type DeviceInfo } from "./android.js";

/**
 * Picks the device for an agent run. Emulators are always allowed; a real phone only when
 * its serial is listed in `devices.allowReal`, because a real phone usually carries
 * someone's own accounts. With nothing running, boots `devices.avd`, or the first emulator
 * image on this machine when none is chosen.
 */
export async function pickDevice(
  projectRoot: string,
  config: ProbeConfig,
  wanted: string | undefined,
  log: (line: string) => void,
): Promise<{ device: AndroidDevice; info: DeviceInfo }> {
  const adb = Adb.forProject(projectRoot);
  const allowed = (d: DeviceInfo) => d.emulator || config.devices.allowReal.includes(d.serial);
  const devices = listDevices(adb);

  if (wanted) {
    const d = devices.find((x) => x.serial === wanted);
    if (!d) throw new Error(`Device ${wanted} is not connected.`);
    if (!allowed(d)) throw new Error(`${wanted} is a real phone. Add it to devices.allowReal in probe/probe.yaml to let agents use it.`);
    return { device: new AndroidDevice(adb, d.serial), info: d };
  }

  let pick = devices.find(allowed);
  if (!pick) {
    const real = devices.filter((d) => !d.emulator).map((d) => `${d.serial} (${d.model})`);
    const avd = config.devices.avd ?? listAvds(projectRoot)[0];
    if (!avd) {
      throw new Error(
        `No emulator running and no emulator image on this machine${real.length ? `; real phones are not used without permission: ${real.join(", ")}` : ""}. Create one in Android Studio → Device Manager.`,
      );
    }
    log(`starting emulator ${avd}${config.devices.avd ? "" : " (first image on this machine; choose another in Studio → Settings)"}…`);
    spawn(sdkTool(projectRoot, "emulator", "emulator"), ["-avd", avd, "-no-snapshot-save", "-no-boot-anim"], {
      detached: true,
      stdio: "ignore",
    }).unref();
    pick = await waitFor(async () => listDevices(adb).find((d) => d.emulator), 120_000);
    if (!pick) throw new Error(`Emulator ${avd} did not come up within 2 minutes.`);
  }

  const device = new AndroidDevice(adb, pick.serial);
  if (!device.isBooted()) {
    log(`waiting for ${pick.serial} to finish booting…`);
    if (!(await waitFor(async () => device.isBooted() || undefined, 180_000))) throw new Error(`${pick.serial} did not finish booting.`);
  }
  return { device, info: pick };
}

async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs: number): Promise<T | undefined> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    throwIfStopped();
    const v = await probe();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return undefined;
}

/** Emulator images (AVDs) on this machine. */
export function listAvds(projectRoot: string): string[] {
  const r = spawnSync(sdkTool(projectRoot, "emulator", "emulator"), ["-list-avds"], { encoding: "utf8", timeout: 15_000 });
  return (r.stdout ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^(INFO|WARNING|ERROR)\b/.test(l));
}
