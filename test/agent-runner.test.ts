import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { claudeRunner } from "../src/agent/claude.js";
import { codexRunner, mcpOverrides, parseCodexUserSettings, tomlString } from "../src/agent/codex.js";
import type { AgentLaunchInput, AgentTask } from "../src/agent/runner.js";
import { agentRunner } from "../src/agent/runners.js";
import { preCommitBlock, parseClaudeInput, withoutPreCommitBlock, withPreCommitBlock } from "../src/cli/hook.js";
import { localAgents, resolveAgents } from "../src/core/config.js";
import { agentCliCheck } from "../src/engine/doctor.js";

const mcp = { command: "C:\\Program Files\\nodejs\\node.exe", args: ["C:\\probe\\dist\\probe.cjs", "mcp"], env: { PROBE_PROJECT: "C:\\Users\\me\\app" } };
const input = (task: Partial<AgentTask>, model = ""): AgentLaunchInput => ({
  task: { prompt: "do it", probeTools: ["probe_cards_context", "probe_cards_save"], ...task },
  model,
  mcp,
  scratchDir: "/tmp/store",
  id: "1",
});
/** The value after a flag, e.g. `--sandbox read-only`. */
const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
const configs = (args: string[]) => args.flatMap((a, i) => (args[i - 1] === "-c" ? [a] : []));

describe("runner selection", () => {
  test("Claude Code is the default runner", () => {
    assert.equal(agentRunner(undefined).id, "claude");
    assert.equal(resolveAgents(undefined, undefined).runner, "claude");
    assert.equal(resolveAgents(undefined, undefined).model, "sonnet");
  });

  test("agents.runner picks Codex, whose default model is its own", () => {
    const agents = resolveAgents({ runner: "codex" }, undefined);
    assert.deepEqual(agents, { runner: "codex", model: "" });
    assert.equal(agentRunner(agents.runner).command, "codex");
  });

  test("an unknown runner falls back to Claude Code", () => {
    assert.equal(resolveAgents({ runner: "gpt" as never }, undefined).runner, "claude");
  });

  test("this machine's runner wins and drops the team's model, which belongs to the team's runner", () => {
    assert.deepEqual(resolveAgents({ runner: "claude", model: "opus" }, { runner: "codex" }), { runner: "codex", model: "" });
    assert.deepEqual(resolveAgents({ model: "opus" }, { runner: "claude" }), { runner: "claude", model: "opus" });
    assert.deepEqual(resolveAgents({ model: "opus" }, { runner: "codex", model: "gpt-x" }), { runner: "codex", model: "gpt-x" });
  });

  test("switching runner in Studio forgets the old model unless a new one comes with it", () => {
    assert.deepEqual(localAgents({ runner: "claude", model: "opus" }, { runner: "codex" }), { runner: "codex" });
    assert.deepEqual(localAgents({ model: "opus" }, { runner: "codex", model: "gpt-x" }), { runner: "codex", model: "gpt-x" });
    assert.equal(localAgents({ runner: "codex" }, { runner: "", model: "" }), undefined);
    assert.equal(typeof localAgents(undefined, { runner: "gemini" }), "string");
  });

  test("doctor checks the chosen runner's CLI", () => {
    const asked: string[] = [];
    const missing = agentCliCheck("codex", (cmd) => (asked.push(cmd), null));
    assert.deepEqual(asked, ["codex"]);
    assert.equal(missing.status, "warn");
    assert.match(missing.fix ?? "", /codex login/);
    assert.equal(agentCliCheck(undefined, () => "2.1.0").detail, "Claude Code 2.1.0");
  });
});

describe("Claude Code arguments", () => {
  test("read-only job: Probe tools and read tools allowed, edits and shell denied", () => {
    const launch = claudeRunner.launch(input({}, "sonnet"));
    assert.equal(launch.command, "claude");
    assert.equal(launch.input, "do it");
    assert.equal(after(launch.args, "--allowedTools"), "mcp__probe__probe_cards_context,mcp__probe__probe_cards_save,Read,Grep,Glob");
    assert.match(after(launch.args, "--disallowedTools")!, /Bash.*Edit,Write$/);
    assert.equal(after(launch.args, "--model"), "sonnet");
    assert.ok(launch.args.includes("--strict-mcp-config"));
    assert.deepEqual(JSON.parse(launch.files[0]!.content), { mcpServers: { probe: mcp } });
    assert.equal(after(launch.args, "--mcp-config"), launch.files[0]!.path);
  });

  test("scoped edits allow only the pattern and leave Edit off the deny list", () => {
    const launch = claudeRunner.launch(input({ editOnly: ["./manifest.yaml"], addDirs: ["/app"] }));
    assert.match(after(launch.args, "--allowedTools")!, /Edit\(\.\/manifest\.yaml\),Write\(\.\/manifest\.yaml\)$/);
    assert.doesNotMatch(after(launch.args, "--disallowedTools")!, /(^|,)(Edit|Write)(,|$)/);
    assert.equal(after(launch.args, "--add-dir"), "/app");
    assert.ok(!launch.args.includes("--model"), "no model: the CLI's own");
  });

  test("stream-json result becomes the agent result", () => {
    const parser = claudeRunner.parser();
    parser.line(JSON.stringify({ type: "system", subtype: "init", model: "sonnet" }));
    const log = parser.line(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "saved 3 cards", total_cost_usd: 0.12, num_turns: 7 }));
    assert.match(log[0]!, /success · 7 turns · \$0\.120/);
    assert.deepEqual(parser.result(), { ok: true, summary: "saved 3 cards", costUsd: 0.12, turns: 7 });
  });
});

describe("Codex CLI arguments", () => {
  const codex = codexRunner(() => ({ model: "gpt-user", windowsSandbox: "elevated" }));

  test("read-only job: exec --json, read-only sandbox, isolated config, Probe attached with only its tools", () => {
    const launch = codex.launch(input({}));
    assert.equal(launch.command, "codex");
    assert.deepEqual(launch.args.slice(0, 5), ["exec", "--json", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config"]);
    assert.equal(after(launch.args, "--sandbox"), "read-only");
    assert.equal(launch.args.at(-1), "-", "prompt on stdin");
    assert.equal(launch.input, "do it");
    assert.equal(after(launch.args, "--model"), "gpt-user", "the user's own model is carried over");
    const c = configs(launch.args);
    assert.ok(c.includes("windows.sandbox='elevated'"));
    assert.ok(c.includes("mcp_servers.probe.enabled_tools=['probe_cards_context', 'probe_cards_save']"));
    assert.ok(c.includes("mcp_servers.probe.default_tools_approval_mode='approve'"));
    assert.ok(!launch.args.includes("shell_tool"), "Codex reads files through its shell");
    assert.equal(launch.files.length, 0);
  });

  test("editing job runs in workspace-write; a named model beats the user's", () => {
    const launch = codex.launch(input({ allowEdits: true }, "gpt-x"));
    assert.equal(after(launch.args, "--sandbox"), "workspace-write");
    assert.equal(after(launch.args, "--model"), "gpt-x");
    assert.ok(!launch.args.includes("--add-dir"), "Codex --add-dir would make a folder writable");
    assert.equal(after(codex.launch(input({ editOnly: ["./manifest.yaml"], addDirs: ["/app"] })).args, "--sandbox"), "workspace-write");
  });

  test("a job with no built-in tools (device runs) gets no shell", () => {
    const args = codex.launch(input({ builtinTools: [] })).args;
    assert.ok(args.includes("shell_tool") && args.includes("unified_exec"));
  });

  test("MCP overrides are TOML that keeps Windows paths and avoids double quotes", () => {
    const c = configs(mcpOverrides(mcp, ["probe_doctor"]));
    assert.deepEqual(c.slice(0, 3), [
      "mcp_servers.probe.command='C:\\Program Files\\nodejs\\node.exe'",
      "mcp_servers.probe.args=['C:\\probe\\dist\\probe.cjs', 'mcp']",
      "mcp_servers.probe.env={ 'PROBE_PROJECT' = 'C:\\Users\\me\\app' }",
    ]);
    assert.equal(tomlString("it's"), '"it\'s"');
  });

  test("reads model and Windows sandbox from the user's config.toml", () => {
    const text = 'model = "gpt-6"\nmodel_reasoning_effort = "high"\n[projects.\'x\']\nmodel = "nope"\n[windows]\nsandbox = "elevated"\n';
    assert.deepEqual(parseCodexUserSettings(text), { model: "gpt-6", windowsSandbox: "elevated" });
  });

  test("JSONL events: tool calls are logged, the last message is the summary", () => {
    const parser = codex.parser();
    const lines = [
      { type: "thread.started", thread_id: "t" },
      { type: "item.started", item: { type: "mcp_tool_call", server: "probe", tool: "probe_cards_save", arguments: { feature: "chat" } } },
      { type: "item.completed", item: { type: "mcp_tool_call", tool: "probe_cards_save", status: "completed" } },
      { type: "item.completed", item: { type: "agent_message", text: "Saved 3 cards." } },
      { type: "turn.completed", usage: { input_tokens: 100, output_tokens: 20 } },
    ].flatMap((e) => parser.line(JSON.stringify(e)));
    assert.deepEqual(lines.slice(0, 3), ["agent started (codex)", "→ probe_cards_save chat", "💬 Saved 3 cards."]);
    assert.deepEqual(parser.result(), { ok: true, summary: "Saved 3 cards.", costUsd: 0, turns: 2 });
  });

  test("a failed turn is a failed result with the error as summary", () => {
    const parser = codex.parser();
    parser.line(JSON.stringify({ type: "turn.failed", error: { message: "model not supported" } }));
    assert.deepEqual(parser.result(), { ok: false, summary: "model not supported", costUsd: 0, turns: 0 });
    assert.equal(codex.parser().result().ok, false, "no events: not a success");
  });

  test("model check reads the answer, and a limit message is not usable", () => {
    const ok = [JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "OK" } }), JSON.stringify({ type: "turn.completed" })].join("\n");
    assert.deepEqual(codex.parseCheck(ok, ""), { ok: true, model: "gpt-user", message: "OK", costUsd: 0 });
    const limited = [JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "You've hit your usage limit" } }), JSON.stringify({ type: "turn.completed" })].join("\n");
    assert.equal(codex.parseCheck(limited, "gpt-x").ok, false);
  });
});

describe("hooks for any agent", () => {
  test("only Claude Code's payload counts as Claude input", () => {
    assert.equal(parseClaudeInput(""), null);
    assert.equal(parseClaudeInput('{"file":"a.ts"}'), null);
    assert.equal(parseClaudeInput('{"hook_event_name":"Stop","session_id":"s"}')?.session_id, "s");
  });

  test("pre-commit block is added once, kept beside an existing hook, and removed cleanly", () => {
    const block = preCommitBlock("C:\\probe\\dist\\probe.cjs");
    assert.match(block, /node "C:\/probe\/dist\/probe.cjs" hook commit .*\|\| true/);
    const fresh = withPreCommitBlock(null, block);
    assert.ok(fresh.startsWith("#!/bin/sh\n"));
    const existing = "#!/bin/sh\nnpm run lint\n";
    const once = withPreCommitBlock(existing, block);
    assert.equal(withPreCommitBlock(once, block), once, "installing again replaces the block");
    assert.equal(withoutPreCommitBlock(once), existing);
  });
});
