import { readFileSync } from "node:fs";
import { join } from "node:path";
import { trackedFiles } from "./history.js";

export interface DocExcerpt {
  /** `path` or `path#heading`. */
  ref: string;
  text: string;
}

/** "editProfile" → ["editprofile", "edit profile", "edit-profile", "edit_profile"]. */
export function nameVariants(featureId: string): string[] {
  const last = featureId.split(":").pop()!;
  const words = last.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[-_]/g, " ").toLowerCase().trim();
  return [...new Set([last.toLowerCase(), words, words.replace(/ /g, "-"), words.replace(/ /g, "_")])];
}

/**
 * Markdown about a feature: a whole file when its name says so, otherwise the sections
 * whose heading names the feature. Body mentions alone are not enough: common words like
 * "comment" appear all over unrelated docs. Bounded, so a big doc set never floods the
 * agent's context.
 */
export function docsAbout(root: string, featureId: string, budget = 16_000): DocExcerpt[] {
  const variants = nameVariants(featureId);
  const mentions = (s: string) => {
    const lower = s.toLowerCase();
    return variants.reduce((n, v) => n + (lower.split(v).length - 1), 0);
  };
  const files = trackedFiles(root, "*.md").filter((f) => !/(^|\/)(build|node_modules)\//.test(f));
  const out: DocExcerpt[] = [];
  let used = 0;
  const add = (ref: string, text: string) => {
    const room = budget - used;
    if (room < 400) return;
    const clipped = text.length > room ? `${text.slice(0, room)}\n…(truncated)` : text;
    out.push({ ref, text: clipped });
    used += clipped.length;
  };

  // Files named after the feature first, then matching sections elsewhere.
  const named = files.filter((f) => variants.some((v) => f.toLowerCase().split("/").pop()!.includes(v.replace(/ /g, ""))));
  for (const f of named) add(f, readFileSync(join(root, f), "utf8"));

  for (const f of files.filter((x) => !named.includes(x))) {
    for (const section of sections(readFileSync(join(root, f), "utf8"))) {
      if (mentions(section.heading) > 0) add(`${f}#${section.heading}`, `${section.heading}\n${section.body}`);
    }
  }
  return out;
}

function sections(md: string): { heading: string; body: string }[] {
  const out: { heading: string; body: string }[] = [];
  let current = { heading: "(top)", body: "" };
  for (const line of md.split(/\r?\n/)) {
    if (/^#{1,3} /.test(line)) {
      if (current.body.trim()) out.push(current);
      current = { heading: line.replace(/^#+ /, ""), body: "" };
    } else {
      current.body += `${line}\n`;
    }
  }
  if (current.body.trim()) out.push(current);
  return out;
}
