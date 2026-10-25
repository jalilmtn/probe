import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { startBackfill, summarizeBackfill } from "./cards/backfill.js";
import { cardContext } from "./cards/context.js";
import { startCardRun, summarizeCardRun } from "./cards/run.js";
import { listCards } from "./cards/store.js";
import { listAccounts, Secrets, type SecretKind } from "./accounts/accounts.js";
import { Adb } from "./devices/adb.js";
import { listDevices } from "./devices/android.js";
import { formatAtlas, formatCards } from "./cli/format.js";
import { CONFIG_TEMPLATE, configPath, saveLocalDevices } from "./core/config.js";
import { openInBrowser } from "./core/proc.js";
import { doctor, formatDoctor } from "./engine/doctor.js";
import { openProject } from "./engine/project.js";
import { findFeature, latestScan, riskyGaps, scan } from "./engine/scan.js";
import { startFix, summarizeFix } from "./engine/fix.js";
import { resultsOverview } from "./engine/ledger.js";
import { fixPrompt, findIssue, issuesOf } from "./engine/issues.js";
import { liveRun, stopRun, type RunEvent } from "./engine/runs.js";
import { startUnitRun, summarizeRun } from "./engine/unit.js";
import { runMcpServer } from "./mcp/server.js";
import { describeLogin, startLoginRun } from "./accounts/login.js";
import { startExploreRun, summarizeExplore } from "./cards/explore.js";
import type { Run } from "./core/types.js";
import { featureHealth } from "./engine/health.js";
import { startUnitWrite, summarizeUnitWrite } from "./engine/unitwrite.js";
import { startVerify, summarizeVerify } from "./engine/verify.js";
import { fileTicket, ticketDraft, ticketInfo } from "./tickets/tickets.js";
import { startStudio } from "./studio/server.js";

const VERSION = "0.1.0";

const HELP = `probe ${VERSION} — agent-driven test platform

Usage: probe <command> [options]

  doctor                 Check setup (Node, project, SDK, devices)
  scan                   Map features: unit coverage and health
  feature <id>           One feature: modules + riskiest untested classes
  unit <feature>         Run a feature's unit tests
  write-tests <feature>  An agent writes unit tests for the riskiest gaps (--limit n)
  cards [feature]        List feature cards (--detail for steps)
  context <feature>      Print what the agent sees before writing cards
  backfill <feature|*>   Draft cards with a headless agent (* = all without cards)
                         --ticket <id> [--ticket-text <file>]: the cards a ticket needs
  run <feature> <card>   Run a card on a device with an agent (--device <serial>)
  explore <feature>      An agent maps a feature's screens and navigation on a device
  verify                 Check a change: affected features' unit tests, then cards on a device
                         --base <branch> --features a,b --ticket <id> --no-device --all-cards --max-cards n
                         --outdated: re-run only results that are outdated or missing; --rerun-fresh: up-to-date ones too
  results [feature]      Recorded results (probe/results, shared via git) and whether they still hold
  login [role]           Check which account the app is logged in with, or log in as role
  issues <run>           Problems a run found, each with an id
  fix-prompt <issue>     A prompt for fixing one issue, for any coding agent
  fix <issue>            An agent fixes the issue in the code, then Probe re-checks it
  ticket <id>            Commits, features and cards of a ticket
  ticket draft <run>     A ticket draft for a run that did not pass
  ticket file <run>      File it with tickets.fileCommand from probe.yaml
  accounts               List test accounts and which secrets this machine has
  account set <role>     Store a password for a test account (--code for a login code)
  devices                List devices and which ones agents may use
  devices allow <serial> Let agents use a real phone (this machine only)
  devices avd <name>     Emulator to boot when none is running
  studio                 Open the local GUI
  mcp                    Run as an MCP server (stdio) for AI agents

Options:
  --project <dir>        Project root (default: current directory)
  --port <n>             Studio port (default 7777)
  --no-open              Don't open the browser for studio
  --model <name>         Model for agent tasks (default: agents.model, else sonnet)
  --device <serial>      Device for run (default: a running emulator)`;

async function main(argv: string[]): Promise<number> {
  const opt = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv.splice(i, 2)[1] : undefined;
  };
  const projectArg = opt("--project");
  const port = Number(opt("--port") ?? 7777);
  const model = opt("--model");
  const deviceArg = opt("--device");
  const baseArg = opt("--base");
  const featuresArg = opt("--features");
  const ticketArg = opt("--ticket");
  const ticketTextArg = opt("--ticket-text");
  const limitArg = opt("--limit");
  const maxCardsArg = opt("--max-cards");
  const flags = new Set(["--no-open", "--detail", "--code", "--no-device", "--all-cards", "--outdated", "--rerun-fresh"]);
  const outdated = argv.includes("--outdated");
  const rerunFresh = argv.includes("--rerun-fresh");
  const noDevice = argv.includes("--no-device");
  const allCards = argv.includes("--all-cards");
  const noOpen = argv.includes("--no-open");
  const detail = argv.includes("--detail");
  const secretKind: SecretKind = argv.includes("--code") ? "code" : "password";
  const [command, arg, arg2] = argv.filter((a) => !flags.has(a));

  switch (command) {
    case "mcp":
      await runMcpServer(VERSION);
      return -1; // keep running
    case "doctor": {
      let checks;
      try {
        checks = doctor(openProject(projectArg));
      } catch (e) {
        checks = doctor(null, (e as Error).message);
      }
      console.log(formatDoctor(checks));
      return checks.some((c) => c.status === "fail") ? 1 : 0;
    }
    case "init": {
      const project = openProject(projectArg);
      const file = configPath(project.root);
      if (existsSync(file)) {
        console.log(`Already exists: ${file}`);
        return 0;
      }
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, CONFIG_TEMPLATE);
      console.log(`Created ${file}`);
      return 0;
    }
    case "scan": {
      const project = openProject(projectArg);
      const result = scan(project);
      console.log(formatAtlas(result, featureHealth(project, result)));
      return 0;
    }
    case "feature": {
      if (!arg) return usage("probe feature <id>");
      const feature = findFeature(latestScan(openProject(projectArg)), arg);
      if (!feature) {
        console.error(`Unknown feature "${arg}". Run \`probe scan\` to list them.`);
        return 1;
      }
      console.log(`${feature.id}: ${feature.stats.testable} testable · ${feature.stats.direct} with test class · ${feature.stats.untested} untested\n`);
      for (const c of riskyGaps(feature)) console.log(`${c.risk.toFixed(1).padStart(5)}  ${c.name.padEnd(40)} ${c.kind.padEnd(10)} ${c.file}`);
      return 0;
    }
    case "unit": {
      if (!arg) return usage("probe unit <feature>");
      const { run: started, done } = startUnitRun(openProject(projectArg), arg);
      follow(started.id);
      const run = await done;
      console.log(`\n${summarizeRun(run)}`);
      return run.status === "passed" ? 0 : 1;
    }
    case "cards":
      console.log(formatCards(listCards(openProject(projectArg).root, arg), detail));
      return 0;
    case "context": {
      if (!arg) return usage("probe context <feature>");
      const project = openProject(projectArg);
      const feature = findFeature(latestScan(project), arg);
      if (!feature) {
        console.error(`Unknown feature "${arg}".`);
        return 1;
      }
      console.log(cardContext(project, feature));
      return 0;
    }
    case "write-tests": {
      if (!arg) return usage("probe write-tests <feature> [--limit n]");
      const { run, done } = startUnitWrite(openProject(projectArg), arg, { limit: limitArg ? Number(limitArg) : undefined, model });
      follow(run.id);
      const finished = await done;
      console.log(`\n${summarizeUnitWrite(finished)}`);
      return finished.status === "passed" ? 0 : 1;
    }
    case "results": {
      // What is recorded in probe/results and whether it still holds for this checkout.
      const project = openProject(projectArg);
      const result = latestScan(project);
      const { cards, unit } = resultsOverview(project, result);
      const icon = { fresh: "✓", stale: "⟳", maybe: "?", never: "·" };
      const rows: string[] = [];
      for (const f of result.features) {
        if (arg && f.id !== arg) continue;
        const u = unit.get(f.id)!;
        const mine = [...cards.entries()].filter(([k]) => k.startsWith(`${f.id}/`));
        if (u.state === "never" && mine.every(([, c]) => c.state === "never")) continue;
        rows.push(`${f.id}`);
        if (u.entry) rows.push(`  ${icon[u.state]} unit       ${u.entry.result} · ${u.entry.at.slice(0, 10)} · ${u.entry.by ?? "?"}${u.reasons.length ? ` — ${u.reasons.join(", ")}` : ""}`);
        for (const [k, c] of mine) rows.push(`  ${icon[c.state]} ${k.slice(f.id.length + 1).padEnd(10)} ${c.entry ? `${c.entry.result} · ${c.entry.at.slice(0, 10)} · ${c.entry.by ?? "?"}` : "never run"}${c.reasons.length ? ` — ${c.reasons.join(", ")}` : ""}`);
      }
      console.log(rows.length ? `✓ up to date  ⟳ outdated  ? maybe outdated  · never\n\n${rows.join("\n")}` : "No results recorded yet.");
      return 0;
    }
    case "issues": {
      if (!arg) return usage("probe issues <run>");
      const project = openProject(projectArg);
      const run = project.store.read<Run>(`runs/${arg}.json`);
      if (!run) return usage(`probe issues <run>  (no run ${arg})`);
      const list = issuesOf(project, run);
      console.log(list.length ? list.map((i) => `${i.id}  [${i.kind}] ${i.title}`).join("\n") : "No issues.");
      return 0;
    }
    case "fix-prompt": {
      if (!arg) return usage("probe fix-prompt <issue>");
      const project = openProject(projectArg);
      const found = findIssue(project, arg);
      if (!found) return usage(`probe fix-prompt <issue>  (no issue ${arg}; see probe issues <run>)`);
      console.log(fixPrompt(project, found.issue, found.run, false));
      return 0;
    }
    case "fix": {
      if (!arg) return usage("probe fix <issue>");
      const { run, done } = startFix(openProject(projectArg), arg, { model });
      follow(run.id);
      const finished = await done;
      console.log(`\n${summarizeFix(finished)}`);
      return finished.status === "passed" ? 0 : 1;
    }
    case "explore": {
      if (!arg) return usage("probe explore <feature> [--device <serial>]");
      const { run, done } = startExploreRun(openProject(projectArg), arg, { device: deviceArg, model });
      follow(run.id);
      const finished = await done;
      console.log(`\n${summarizeExplore(finished)}`);
      return finished.status === "passed" ? 0 : 1;
    }
    case "verify": {
      const { run, done } = startVerify(openProject(projectArg), {
        base: baseArg,
        features: featuresArg?.split(",").map((f) => f.trim()).filter(Boolean),
        ticket: ticketArg,
        noDevice,
        cards: allCards ? "all" : undefined,
        maxCards: maxCardsArg ? Number(maxCardsArg) : undefined,
        device: deviceArg,
        model,
        outdated,
        rerunFresh,
      });
      follow(run.id);
      const finished = await done;
      console.log(`\n${summarizeVerify(finished)}`);
      return finished.status === "passed" ? 0 : 1;
    }
    case "login": {
      const { run, done } = startLoginRun(openProject(projectArg), arg, { device: deviceArg, model });
      follow(run.id);
      const finished = await done;
      console.log(`\nLogin ${finished.status}: ${finished.login ? describeLogin(finished.login) : (finished.error ?? "no report")}`);
      return finished.status === "passed" ? 0 : 1;
    }
    case "ticket": {
      const project = openProject(projectArg);
      if ((arg === "draft" || arg === "file") && arg2) {
        const run = project.store.read<Run>(`runs/${arg2}.json`);
        if (!run) {
          console.error(`Unknown run ${arg2}.`);
          return 1;
        }
        if (arg === "file") {
          console.log(fileTicket(project, run));
          return 0;
        }
        const d = ticketDraft(project, run);
        console.log(`# ${d.title}\n\n${d.body}`);
        return 0;
      }
      if (!arg) return usage("probe ticket <id> | ticket draft <run> | ticket file <run>");
      const info = ticketInfo(project, arg);
      console.log(`${info.id}${info.url ? ` · ${info.url}` : ""}\nFeatures: ${info.features.join(", ") || "none found"}\nCards: ${info.cards.join(", ") || "none"}`);
      for (const c of info.commits) console.log(`  ${c.hash} ${c.date} ${c.subject}`);
      return 0;
    }
    case "backfill": {
      const project = openProject(projectArg);
      // From a ticket, the features default to the ones its commits touched.
      const targets = arg ?? (ticketArg ? ticketInfo(project, ticketArg).features : undefined);
      if (!targets || (Array.isArray(targets) && targets.length === 0)) return usage("probe backfill <feature|*> [--ticket <id> [--ticket-text <file>]]");
      const ticket = ticketArg ? { id: ticketArg, text: ticketTextArg ? readFileSync(ticketTextArg, "utf8") : undefined } : undefined;
      const { run, done } = startBackfill(project, targets, { model, ticket });
      follow(run.id);
      const finished = await done;
      console.log(`\n${summarizeBackfill(finished)}`);
      return finished.status === "passed" ? 0 : 1;
    }
    case "run": {
      if (!arg || !arg2) return usage("probe run <feature> <card> [--device <serial>]");
      const { run, done } = startCardRun(openProject(projectArg), arg, arg2, { device: deviceArg, model });
      follow(run.id);
      const finished = await done;
      console.log(`\n${summarizeCardRun(finished)}`);
      return finished.status === "passed" ? 0 : 1;
    }
    case "accounts": {
      const project = openProject(projectArg);
      const secrets = new Secrets(project.store.dir);
      const accounts = listAccounts(project.root);
      if (accounts.length === 0) {
        console.log("No test accounts. Add them to probe/hints/accounts.yaml:\n\naccounts:\n  - role: user_a\n    username: tester.a@example.com\n    notes: main tester");
        return 0;
      }
      for (const a of accounts) {
        const has = (k: SecretKind) => (secrets.has(a.role, k) ? "✓" : "—");
        console.log(`${a.role.padEnd(12)} ${a.username.padEnd(32)} password ${has("password")}  code ${has("code")}${a.notes ? `  ${a.notes}` : ""}`);
      }
      return 0;
    }
    case "account": {
      if (arg !== "set" || !arg2) return usage("probe account set <role> [--code]   (reads the value from stdin)");
      const project = openProject(projectArg);
      if (!listAccounts(project.root).some((a) => a.role === arg2)) {
        console.error(`No role "${arg2}" in probe/hints/accounts.yaml.`);
        return 1;
      }
      const value = await readSecret(`${secretKind === "code" ? "Login code" : "Password"} for ${arg2}: `);
      // Studio -> Accounts does the same without a terminal.
      if (!value) return usage("an empty value was given");
      new Secrets(project.store.dir).set(arg2, secretKind, value);
      console.log(`Stored ${arg2}'s ${secretKind} on this machine only.`);
      return 0;
    }
    case "devices": {
      const project = openProject(projectArg);
      const local = project.config.devices;
      if (arg === "allow" && arg2) {
        saveLocalDevices(project.store.dir, { ...local, allowReal: [...new Set([...local.allowReal, arg2])] });
        console.log(`Agents may now use ${arg2} on this machine.`);
        return 0;
      }
      if (arg === "avd" && arg2) {
        saveLocalDevices(project.store.dir, { ...local, avd: arg2 });
        console.log(`Will boot ${arg2} when no emulator is running.`);
        return 0;
      }
      const devices = listDevices(Adb.forProject(project.root));
      if (devices.length === 0) console.log("No devices connected.");
      for (const d of devices) {
        const ok = d.emulator || local.allowReal.includes(d.serial);
        console.log(`${d.serial.padEnd(20)} ${d.model.padEnd(20)} ${d.emulator ? "emulator  " : "real phone"}  ${ok ? "agents allowed" : "agents NOT allowed (probe devices allow <serial>)"}`);
      }
      console.log(`\nEmulator to boot when none runs: ${local.avd ?? "not set (probe devices avd <name>)"}`);
      return 0;
    }
    case "studio": {
      const url = await startStudio(openProject(projectArg), port);
      console.log(`Probe Studio: ${url}  (Ctrl+C to stop)`);
      if (!noOpen) openInBrowser(url);
      return -1;
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return 0;
    case "--version":
      console.log(VERSION);
      return 0;
    default:
      console.error(`Unknown command "${command}".\n`);
      console.log(HELP);
      return 1;
  }
}

/** Reads a secret from stdin; on a terminal the typed characters are not echoed. */
async function readSecret(promptText: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    let data = "";
    for await (const chunk of stdin) data += chunk;
    return data.replace(/\r?\n$/, "");
  }
  process.stdout.write(promptText);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve) => {
    let value = "";
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") process.exit(130);
        value = ch === "\u007f" || ch === "\b" ? value.slice(0, -1) : value + ch;
      }
    };
    stdin.on("data", onData);
  });
}

/** Prints a run's log lines as they arrive. */
function follow(runId: string): void {
  // Ctrl+C stops the run properly: its build or agent is killed, and it is saved as stopped.
  process.once("SIGINT", () => {
    console.log("\nstopping…");
    if (!stopRun(runId)) process.exit(130);
  });
  liveRun(runId)?.events.on("event", (e: RunEvent) => {
    if (e.type === "log") console.log(e.line);
  });
}

function usage(line: string): number {
  console.error(`Usage: ${line}`);
  return 1;
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exit(code);
  },
  (e) => {
    console.error(`probe: ${(e as Error).message}`);
    process.exit(1);
  },
);
