import type { ProjectAdapter } from "./adapter.js";
import { androidGradleAdapter } from "./android-gradle/index.js";
import { genericAdapter } from "./generic/index.js";
import { nodeAdapter } from "./node/index.js";

/**
 * Add an adapter here to teach Probe a new kind of project. First match wins, so the most
 * specific come first; the generic one takes any git repository and stays last.
 */
export const ADAPTERS: ProjectAdapter[] = [androidGradleAdapter, nodeAdapter, genericAdapter];

export function detectAdapter(root: string): ProjectAdapter | null {
  return ADAPTERS.find((a) => a.detect(root)) ?? null;
}
