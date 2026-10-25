import type { ProjectAdapter } from "./adapter.js";
import { androidGradleAdapter } from "./android-gradle/index.js";

/** Add an adapter here to teach Probe a new kind of project. First match wins. */
const ADAPTERS: ProjectAdapter[] = [androidGradleAdapter];

export function detectAdapter(root: string): ProjectAdapter | null {
  return ADAPTERS.find((a) => a.detect(root)) ?? null;
}
