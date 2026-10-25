import type { Project } from "./project.js";

export interface ResolvedApp {
  package?: string;
  installTask?: string;
  /** Where each value came from, for Studio. */
  packageSource: "probe.yaml" | "last build" | "build file" | null;
  installSource: "probe.yaml" | "detected" | null;
  module?: string;
}

/**
 * The app agents test: whatever probe.yaml says, else what the adapter finds in the project.
 * Nobody has to configure a standard project; probe.yaml only overrides a wrong guess.
 */
export function resolveApp(project: Project): ResolvedApp {
  const set = project.config.app;
  const found = project.adapter.detectApp(project.root);
  return {
    package: set.package ?? found?.package,
    installTask: set.installTask ?? found?.installTask,
    packageSource: set.package ? "probe.yaml" : found?.package ? (found.source as "last build" | "build file") : null,
    installSource: set.installTask ? "probe.yaml" : found ? "detected" : null,
    module: found?.module,
  };
}
