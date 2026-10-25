import { newRunId } from "../core/store.js";
import type { LoginRun, LoginState } from "../core/types.js";
import { crashError, DEVICE_HOW_TO, runOnDevice } from "../devices/harness.js";
import type { Project } from "../engine/project.js";
import { launchRun } from "../engine/runs.js";
import { accountsForPrompt, listAccounts } from "./accounts.js";

function prompt(project: Project, wanted: string | undefined, device: string, pkg: string): string {
  const task = wanted
    ? `Make sure the app is logged in with the test account "${wanted}". If it is logged in with another account, log out first (only through the app's own logout). If it is logged out, log in as ${wanted}.`
    : "Find out whether the app is logged in and with which account. Do not log in or out: only look (open the profile or settings screen if you need to see who is logged in).";
  return `You are checking the login state of the Android app ${pkg} on ${device}. The app has just been launched.

## Task
${task}

## Test accounts
${accountsForPrompt(project)}

${DEVICE_HOW_TO}

## Finish
Call probe_login_report exactly once: state (logged_in / logged_out / unknown), role (the test account role if the app shows one of the test accounts — by username or by its "shown in the app as" name — null otherwise), seenAs (the name or handle the app shows), and notes. Then stop.`;
}

/** Checks which account the app on a device uses, or logs it in with `wanted`. */
export function startLoginRun(project: Project, wanted?: string, options: { device?: string; model?: string } = {}): { run: LoginRun; done: Promise<LoginRun> } {
  if (wanted && !listAccounts(project.root).some((a) => a.role === wanted)) throw new Error(`No test account with role "${wanted}".`);
  const run: LoginRun = {
    id: newRunId(),
    kind: "login",
    feature: "*",
    wanted,
    device: "",
    startedAt: new Date().toISOString(),
    status: "running",
    crashes: [],
    timeline: [],
    costUsd: 0,
  };
  return launchRun(project, run, async (log) => {
    const session = await runOnDevice(project, run, { ...options, prompt: (d, pkg) => prompt(project, wanted, d, pkg), reportTools: ["probe_login_report"] }, log);
    run.login = session.report<LoginState>("login") ?? undefined;
    const crashed = crashError(run);
    if (crashed) {
      run.status = "failed";
      run.error = crashed;
    } else if (!run.login) {
      run.status = "error";
      run.error = "The agent finished without reporting the login state.";
    } else if (wanted) {
      run.status = run.login.state === "logged_in" && run.login.role === wanted ? "passed" : "blocked";
    } else {
      run.status = "passed";
    }
    if (run.login) log(`login: ${describeLogin(run.login)}`);
  });
}

export function describeLogin(l: LoginState): string {
  if (l.state === "logged_out") return "logged out";
  if (l.state === "unknown") return `unknown${l.notes ? ` (${l.notes})` : ""}`;
  return l.role ? `logged in as ${l.role}${l.seenAs ? ` (${l.seenAs})` : ""}` : `logged in with a NON-test account${l.seenAs ? ` (${l.seenAs})` : ""}`;
}

/** The newest finished login run's view of the device, for Studio and agents. */
export function lastLogin(project: Project): { run: LoginRun; at: string } | null {
  const run = project.store.listRuns<LoginRun>().find((r) => r.kind === "login" && r.login);
  return run ? { run, at: run.finishedAt ?? run.startedAt } : null;
}
