import type { Platform, Rule } from "../rule.js";
import { ANDROID } from "./android.js";
import { BACKEND } from "./backend.js";
import { COMMON } from "./common.js";
import { DESKTOP } from "./desktop.js";
import { IOS } from "./ios.js";
import { CROSS_MOBILE } from "./mobile.js";
import { WEB } from "./web.js";

/** Every static rule Probe knows, from the catalogs in docs/security. */
export const RULES: Rule[] = [...COMMON, ...ANDROID, ...IOS, ...WEB, ...BACKEND, ...CROSS_MOBILE, ...DESKTOP];

/** Rules that run on a project with these platforms; "common" always runs. */
export function rulesFor(platforms: Set<Platform>): Rule[] {
  return RULES.filter((r) => r.platform === "common" || platforms.has(r.platform));
}
