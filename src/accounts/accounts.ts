import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import { CONFIG_DIR } from "../core/config.js";
import { isWindows } from "../core/proc.js";

/** A test account as the team shares it: a role and a username, never a password. */
export interface Account {
  role: string;
  username: string;
  /** How the app shows this account once logged in (display name or @handle), so an agent can recognise it. */
  shownAs?: string;
  notes?: string;
}

export type SecretKind = "password" | "code";

export function accountsFile(root: string): string {
  return join(root, CONFIG_DIR, "hints", "accounts.yaml");
}

export function listAccounts(root: string): Account[] {
  const file = accountsFile(root);
  if (!existsSync(file)) return [];
  const raw = (parse(readFileSync(file, "utf8")) ?? {}) as { accounts?: Account[] };
  return (raw.accounts ?? []).filter((a) => a.role && a.username);
}

/** The test accounts as a device agent sees them: roles and usernames, and whether a secret is stored. */
export function accountsForPrompt(project: { root: string; store: { dir: string } }): string {
  const secrets = new Secrets(project.store.dir);
  const lines = listAccounts(project.root).map(
    (a) =>
      `- ${a.role}: ${a.username}${a.shownAs ? ` · shown in the app as "${a.shownAs}"` : ""}${a.notes ? ` (${a.notes})` : ""} · password ${secrets.has(a.role, "password") ? "stored" : "NOT stored"} · login code ${secrets.has(a.role, "code") ? "stored" : "not stored"}`,
  );
  return lines.length ? lines.join("\n") : "None configured.";
}

/** Adds or replaces the account with this role in the shared accounts file. */
export function saveAccount(root: string, account: Account): void {
  const accounts = listAccounts(root).filter((a) => a.role !== account.role);
  writeAccounts(root, [
    ...accounts,
    { role: account.role, username: account.username, ...(account.shownAs ? { shownAs: account.shownAs } : {}), ...(account.notes ? { notes: account.notes } : {}) },
  ]);
}

export function removeAccount(root: string, role: string): void {
  writeAccounts(root, listAccounts(root).filter((a) => a.role !== role));
}

function writeAccounts(root: string, accounts: Account[]): void {
  const file = accountsFile(root);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `# Test accounts: roles and usernames only. Passwords stay on each machine.\n${stringify({ accounts })}`);
}

/**
 * Passwords and fixed login codes, per machine, outside the repo. On Windows each value is
 * encrypted for the current Windows user (DPAPI); elsewhere the file is readable by its
 * owner only. Agents never receive these: the engine types them on the device.
 */
export class Secrets {
  private readonly file: string;

  constructor(storeDir: string) {
    this.file = join(storeDir, "secrets.json");
  }

  private load(): Record<string, string> {
    return existsSync(this.file) ? (JSON.parse(readFileSync(this.file, "utf8")) as Record<string, string>) : {};
  }

  has(role: string, kind: SecretKind): boolean {
    return `${role}.${kind}` in this.load();
  }

  get(role: string, kind: SecretKind): string | null {
    const sealed = this.load()[`${role}.${kind}`];
    return sealed === undefined ? null : unseal(sealed);
  }

  set(role: string, kind: SecretKind, value: string): void {
    const all = this.load();
    all[`${role}.${kind}`] = seal(value);
    writeFileSync(this.file, JSON.stringify(all, null, 2));
    if (!isWindows) chmodSync(this.file, 0o600);
  }

  /** Forgets every secret of a role. */
  remove(role: string): void {
    const all = this.load();
    for (const kind of ["password", "code"] as const) delete all[`${role}.${kind}`];
    writeFileSync(this.file, JSON.stringify(all, null, 2));
  }
}

const PS_PROTECT =
  "Add-Type -AssemblyName System.Security; [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($env:PROBE_SECRET), $null, 'CurrentUser'))";
const PS_UNPROTECT =
  "Add-Type -AssemblyName System.Security; [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($env:PROBE_SECRET), $null, 'CurrentUser'))";

/** The value travels through an environment variable, never a command line other processes can read. */
function powershell(script: string, input: string): string {
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    env: { ...process.env, PROBE_SECRET: input },
    timeout: 20_000,
  });
  if (r.status !== 0) throw new Error(`Could not access the Windows credential store: ${r.stderr.trim()}`);
  return r.stdout.replace(/\r?\n$/, "");
}

function seal(value: string): string {
  return isWindows ? `dpapi:${powershell(PS_PROTECT, value)}` : `plain:${value}`;
}

function unseal(sealed: string): string {
  if (sealed.startsWith("dpapi:")) return powershell(PS_UNPROTECT, sealed.slice(6));
  return sealed.replace(/^plain:/, "");
}
