import type { ClassInfo, ClassKind } from "./types.js";

/** How much a class of each kind is worth unit-testing. Adapters classify; this decides. */
export const KIND_WEIGHT: Record<ClassKind, number> = {
  reducer: 5,
  usecase: 4,
  viewmodel: 4,
  mapper: 3,
  repository: 3,
  logic: 3,
  other: 2,
  ui: 1,
  model: 0.5,
  di: 0,
  interface: 0,
};

export function isTestable(c: Pick<ClassInfo, "kind">): boolean {
  return KIND_WEIGHT[c.kind] >= 1;
}
