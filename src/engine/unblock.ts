import { listAccounts } from "../accounts/accounts.js";
import type { BlockReason, CardRun, Run, VerifyRun, WorkRun } from "../core/types.js";
import type { Project } from "./project.js";

/**
 * A blocked run is not a bug in the app: something outside the code stopped it (a sign-in, the
 * wrong account on the device, a code the agent does not have, data the card needs). This works
 * out which, says what to do, and names the cards to run again once it is done.
 */
export interface Unblock {
  /** The run whose cards are run again: the card run itself, or the verify that ran them. */
  runId: string;
  reason: BlockReason;
  /** One line: why it stopped. */
  title: string;
  /** What the agent said, as it said it. */
  seen: string;
  /** What to do before running again. */
  todo: string;
  /** Where in Studio that is done, when it is a setting. */
  settings?: "accounts";
  /** Probe can sign in on the device with a stored test account. */
  canSignIn: boolean;
  /** Each card that was blocked, or skipped because of it, as feature/card. */
  cards: string[];
}

const TITLE: Record<BlockReason, string> = {
  "sign-in": "The test account could not sign in",
  "wrong-account": "The app is signed in with an account that is not a test account",
  "needs-code": "Signing in needs a code the agent does not have",
  "missing-data": "The app did not have what the card needs",
  "no-connection": "The app could not reach its server",
  other: "The agent could not finish the card",
};

/** Why a card stopped, from what the agent reported, or from its notes for runs before `blockedBy`. */
export function blockReason(said: BlockReason | undefined, notes: string): BlockReason {
  if (said) return said;
  const n = notes.toLowerCase();
  if (/not (one of )?the test accounts?|non-test account|not a test account|wrong account|real account/.test(n)) return "wrong-account";
  if (/no (internet )?connection|trying to reconnect|offline|failed to (post|upload|load|send)|network error|could not connect|can't connect|never finish/.test(n)) return "no-connection";
  if (/\b(sms|email|verification|one[- ]time|2fa|two[- ]factor|otp|login) code\b|captcha/.test(n)) return "needs-code";
  if (/(sign[- ]?in|log[- ]?in|password)[^.]{0,60}(refused|rejected|failed|wrong|incorrect|invalid|did not work|error)|(wrong|incorrect|invalid) (password|credentials)|could not (sign|log) ?in/.test(n)) return "sign-in";
  if (/\bno (active |existing )?\w+ (to|yet)\b|there (is|are|was|were) no\b|nothing to (open|test|show)|first (post|create|add)|needs? (an?|some|existing) /.test(n)) return "missing-data";
  return "other";
}

function todoFor(reason: BlockReason, project: Project): Pick<Unblock, "todo" | "settings"> {
  const accounts = listAccounts(project.root).length;
  switch (reason) {
    case "sign-in":
      return {
        todo: accounts
          ? "Check the username and password in Settings → Test accounts (signing in once by hand on the device shows whether they work), then run again."
          : "Add a test account in Settings → Test accounts, then run again.",
        settings: "accounts",
      };
    case "wrong-account":
      return {
        todo: accounts
          ? "If the account on the device is one of your test accounts, its \"Shown as\" name in Settings → Test accounts is out of date: set it to what the app shows. Otherwise sign in as a test account, or press Sign in as a test account to let Probe do it. Then run again."
          : "Sign out on the device and add a test account in Settings → Test accounts, then run again.",
        settings: "accounts",
      };
    case "needs-code":
      return { todo: "Store the code with the test account in Settings → Test accounts, or sign in by hand on the device once, then run again.", settings: "accounts" };
    case "no-connection":
      return { todo: "Check that the device reaches the app's server: its Wi-Fi or mobile data, a VPN, the server address of this build, and that the server is up. Open the app by hand to see it load, then run again." };
    case "missing-data":
      return { todo: "Prepare what the agent says is missing on the device (or with the test account), then run again." };
    default:
      return { todo: "Read what the agent said, sort out what it names, then run again." };
  }
}

function fromCard(project: Project, run: CardRun, runId: string, cards: string[]): Unblock {
  const seen = run.verdict?.notes || run.error || "";
  const reason = blockReason(run.verdict?.blockedBy, seen);
  return { runId, reason, title: TITLE[reason], seen, ...todoFor(reason, project), canSignIn: reason === "wrong-account" && listAccounts(project.root).length > 0, cards };
}

/** What blocked `run` and how to get past it, or null when nothing in it was blocked. */
export function unblockOf(project: Project, run: Run): Unblock | null {
  const read = (id?: string) => (id && /^[\w-]+$/.test(id) ? project.store.read<Run>(`runs/${id}.json`) : null);
  if (run.status === "running") return null;
  if (run.kind === "card") return run.status === "blocked" ? fromCard(project, run, run.id, [`${run.feature}/${run.cardId}`]) : null;
  if (run.kind === "verify") return fromVerify(project, run, read);
  if (run.kind === "work") {
    // A ticket waiting on you after its device step: the verify that step ran.
    for (const t of (run as WorkRun).tickets) {
      const ui = t.steps.find((s) => s.step === "ui" && s.status !== "passed" && s.runId);
      const verify = ui && read(ui.runId);
      if (verify?.kind === "verify") {
        const found = fromVerify(project, verify, read);
        if (found) return found;
      }
    }
  }
  return null;
}

function fromVerify(project: Project, run: VerifyRun, read: (id?: string) => Run | null): Unblock | null {
  const rows = run.features.flatMap((f) => f.cards.map((c) => ({ ...c, feature: f.feature })));
  const blocked = rows.filter((c) => c.status === "blocked");
  if (!blocked.length) return null;
  // Cards left out because a sign-in failed run again with the blocked ones.
  const skipped = rows.filter((c) => c.status === "skipped" && c.note?.startsWith("not run: sign-in failed"));
  const cards = [...blocked, ...skipped].map((c) => `${c.feature}/${c.cardId}`);
  const first = read(blocked[0]!.runId);
  if (first?.kind === "card") return fromCard(project, first, run.id, cards);
  const seen = blocked[0]!.note ?? "";
  const reason = blockReason(undefined, seen);
  return { runId: run.id, reason, title: TITLE[reason], seen, ...todoFor(reason, project), canSignIn: reason === "wrong-account" && listAccounts(project.root).length > 0, cards };
}
