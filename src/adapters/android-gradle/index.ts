import { existsSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import type { ProbeConfig } from "../../core/config.js";
import { capture, isWindows, stream } from "../../core/proc.js";
import { Adb, androidSdk } from "../../devices/adb.js";
import { listDevices } from "../../devices/android.js";
import type { DoctorCheck, ModuleInfo, ModuleTestResult } from "../../core/types.js";
import type { ProjectAdapter, UnitInvocation } from "../adapter.js";
import { detectAndroidApp } from "./app.js";
import { moduleDependencies } from "./deps.js";
import { indexTests, inventory, sourceSetFiles } from "./inventory.js";
import { readJUnitResults } from "./junit.js";
import { includedModules, settingsFile } from "./settings.js";

export const androidGradleAdapter: ProjectAdapter = {
  id: "android-gradle",
  label: "Android/Gradle",
  ignoredDirs: ["build", ".gradle", ".kotlin", ".cxx"],
  supportsDevices: true,

  detect(root) {
    return settingsFile(root) !== null;
  },

  projectName(root) {
    const file = settingsFile(root);
    const named = file && /rootProject\.name\s*=\s*["']([^"']+)["']/.exec(readFileSync(file, "utf8"))?.[1];
    return named || basename(root);
  },

  scanModules(root, config) {
    return includedModules(root).map(({ id, dir }) => {
      const buildFile = readFileSync(existsSync(join(dir, "build.gradle.kts")) ? join(dir, "build.gradle.kts") : join(dir, "build.gradle"), "utf8");
      const platform = /android/i.test(buildFile) ? "android" : /jvm|java-library|kotlin\("jvm"\)/.test(buildFile) ? "jvm" : "unknown";
      const main = sourceSetFiles(dir, "main");
      const test = sourceSetFiles(dir, "test");
      const instrumented = sourceSetFiles(dir, "androidTest");
      const task = platform === "jvm" ? config.unit.jvmTask : config.unit.androidTask;
      return {
        id,
        dir,
        platform,
        mainFiles: main.length,
        testFiles: test.length,
        instrumentedTestFiles: instrumented.length,
        unitTestTask: test.length > 0 ? `${id}:${task}` : null,
        classes: inventory(root, main, indexTests(test)),
      } satisfies ModuleInfo;
    });
  },

  async runUnitTests(root, modules, onLine): Promise<UnitInvocation> {
    const tasks = modules.map((m) => m.unitTestTask).filter((t): t is string => t !== null);
    const args = [...tasks, "--continue"];
    const command = `${isWindows ? "gradlew.bat" : "./gradlew"} ${args.join(" ")}`;
    onLine(`$ ${command}`);
    const reused: string[] = [];
    const exitCode = await stream(gradlew(root), args, root, (line) => {
      const skipped = /^> Task (\S+) (UP-TO-DATE|FROM-CACHE)/.exec(line);
      if (skipped && tasks.includes(skipped[1]!)) reused.push(skipped[1]!.slice(0, skipped[1]!.lastIndexOf(":")));
      onLine(line);
    });
    return { command, exitCode, reused };
  },

  collectUnitResults(_root, modules, sinceMs, invocation): ModuleTestResult[] {
    return modules
      .filter((m) => m.unitTestTask)
      .map((m): ModuleTestResult | null => {
        const taskName = m.unitTestTask!.split(":").pop()!;
        const cached = invocation.reused.includes(m.id);
        const result = readJUnitResults(m.id, join(m.dir, "build", "test-results", taskName), cached ? 0 : sinceMs);
        return result && { ...result, cached };
      })
      .filter((r): r is ModuleTestResult => r !== null);
  },

  installApp(root, task, deviceSerial, onLine) {
    onLine(`$ gradlew ${task}  (ANDROID_SERIAL=${deviceSerial})`);
    // Stack frames from the build's own warnings would bury the run log; keep the rest.
    const keep = (line: string) => {
      if (!/^\s+at /.test(line)) onLine(line);
    };
    return stream(gradlew(root), [task], root, keep, { env: { ...process.env, ANDROID_SERIAL: deviceSerial } });
  },

  detectApp(root) {
    return detectAndroidApp(root);
  },

  moduleDependencies(root) {
    return moduleDependencies(includedModules(root));
  },

  isTestSource(relPath) {
    return /(^|\/)src\/(test|androidTest|testFixtures|sharedTest)[^/]*\//.test(relPath.replace(/\\/g, "/"));
  },

  navigationHints(root, modules, limit) {
    const out: string[] = [];
    for (const m of modules) {
      for (const file of sourceSetFiles(m.dir, "main")) {
        const lines = readFileSync(file, "utf8").split(/\r?\n/);
        lines.forEach((text, i) => {
          if (out.length < limit && NAV_HINT.test(text)) {
            out.push(`${relative(root, file).replace(/\\/g, "/")}:${i + 1}: ${text.trim().slice(0, 160)}`);
          }
        });
      }
    }
    return out;
  },

  doctor(root) {
    const checks: DoctorCheck[] = [];
    const wrapper = existsSync(join(root, isWindows ? "gradlew.bat" : "gradlew"));
    checks.push({
      id: "gradle-wrapper",
      label: "Gradle wrapper",
      status: wrapper ? "ok" : "fail",
      detail: wrapper ? "found" : "no gradlew in project root",
      fix: wrapper ? undefined : "Run `gradle wrapper` in the project",
    });

    const sdk = androidSdk(root);
    checks.push({
      id: "android-sdk",
      label: "Android SDK",
      status: sdk ? "ok" : "fail",
      detail: sdk ?? "not found (ANDROID_HOME / local.properties sdk.dir)",
      fix: sdk ? undefined : "Install the SDK via Android Studio and set ANDROID_HOME",
    });

    const adb = Adb.forProject(root);
    const version = adb.run(["version"]);
    checks.push({
      id: "adb",
      label: "adb",
      status: version.ok ? "ok" : "fail",
      detail: version.ok ? version.out.split("\n")[0]!.trim() : "adb not runnable",
    });
    const devices = listDevices(adb);
    checks.push({
      id: "devices",
      label: "Connected devices",
      status: devices.length > 0 ? "ok" : "warn",
      detail:
        devices.length > 0
          ? devices.map((d) => `${d.serial} (${d.model}, ${d.emulator ? "emulator" : "real phone — agents need permission"})`).join(", ")
          : "none (only needed for agent tests)",
      fix: devices.length > 0 ? undefined : "Start an emulator or connect a phone with USB debugging",
    });

    const emulator = sdk ? join(sdk, "emulator", isWindows ? "emulator.exe" : "emulator") : null;
    const avds = emulator && existsSync(emulator) ? (capture(emulator, ["-list-avds"]) ?? "").split("\n").filter(Boolean) : [];
    checks.push({
      id: "avds",
      label: "Emulator images",
      status: avds.length > 0 ? "ok" : "warn",
      detail: avds.length > 0 ? avds.join(", ") : "no AVD found",
      fix: avds.length > 0 ? undefined : "Create one in Android Studio → Device Manager (x86_64, API 34+)",
    });
    return checks;
  },
};

/** Absolute path: cmd.exe skips the current directory when NoDefaultCurrentDirectoryInExePath is set. */
function gradlew(root: string): string {
  const wrapper = join(root, isWindows ? "gradlew.bat" : "gradlew");
  return isWindows ? `"${wrapper}"` : wrapper;
}

/** Compose navigation destinations, nav graphs, deep links and Activities started by intent. */
const NAV_HINT =
  /\bcomposable<|\bnavigation<|\bNavHost\(|startDestination|deepLinks?\s*[=(]|navDeepLink|uriPattern|@Serializable\s+(data\s+)?(object|class)\s+\w*(Route|Destination|Screen|Graph)\b|\bnavigateTo\w*\(|Intent\(\s*\w+,\s*\w+Activity::class/;
