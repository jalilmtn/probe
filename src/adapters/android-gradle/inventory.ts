import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { KIND_WEIGHT } from "../../core/kinds.js";
import type { ClassInfo, ClassKind, TestLink } from "../../core/types.js";

const SOURCE_EXT = /\.(kt|java)$/;

export function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (SOURCE_EXT.test(entry.name)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** Source sets for a source-set kind: `main` → src/main, plus build-type/flavor variants are ignored. */
export function sourceSetFiles(moduleDir: string, set: "main" | "test" | "androidTest"): string[] {
  return sourceFiles(join(moduleDir, "src", set));
}

interface DeclaredClass {
  name: string;
  keyword: "class" | "object" | "interface";
  modifiers: string[];
}

const DECLARATION =
  /^(?:@\w+(?:\([^)]*\))?\s+)*((?:(?:public|internal|private|protected|abstract|open|final|data|sealed|enum|value|inline|annotation|fun|static)\s+)*)(class|object|interface)\s+([A-Z]\w*)/;

/** Top-level declarations only: a class nested inside another is tested through its parent. */
function declaredClasses(text: string): DeclaredClass[] {
  const out: DeclaredClass[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = DECLARATION.exec(line);
    if (!m) continue;
    out.push({ name: m[3]!, keyword: m[2] as DeclaredClass["keyword"], modifiers: m[1]!.trim().split(/\s+/).filter(Boolean) });
  }
  return out;
}

const LOGIC_SUFFIX =
  /(Manager|Handler|Service|Delegate|Store|Interactor|Presenter|Validator|Parser|Formatter|Calculator|Resolver|Controller|Coordinator|Runner|Gate|Policy|Engine|Client|Cache|Tracker|Scheduler|Processor|Worker|PagingSource|Builder|Interceptor|Observer|Synchronizer)$/;
const MODEL_SUFFIX = /(State|Event|Effect|Intent|Signal|Action|Dto|DTO|Entity|Model|Request|Response|Args|Params|Config|Type|Mode|Reason|Error|Exception)$/;
const UI_SUFFIX = /(Activity|Fragment|Screen|View|Dialog|BottomSheet|Adapter|ViewHolder|Composable|Theme|Colors|Typography|Icons)$/;

function classify(c: DeclaredClass, fileText: string): ClassKind {
  const n = c.name.replace(/Impl$/, "");
  if (c.keyword === "interface" && !c.modifiers.includes("sealed")) return "interface";
  if (/Module$|Component$/.test(n) || (fileText.includes("@Module") && c.keyword !== "class")) return "di";
  if (c.modifiers.includes("data") || c.modifiers.includes("enum") || c.modifiers.includes("annotation")) return "model";
  if (c.modifiers.includes("sealed") && MODEL_SUFFIX.test(n)) return "model";
  if (/Reducer$/.test(n)) return "reducer";
  if (/UseCase$/.test(n)) return "usecase";
  if (/ViewModel$/.test(n)) return "viewmodel";
  if (/Repository$|DataSource$|Dao$/.test(n)) return "repository";
  if (/Mapper$|Converter$|Serializer$|Adapter$/.test(n) && !/ViewHolder|RecyclerView/.test(fileText)) return "mapper";
  if (UI_SUFFIX.test(n)) return "ui";
  if (MODEL_SUFFIX.test(n)) return "model";
  if (LOGIC_SUFFIX.test(n)) return "logic";
  return "other";
}

const TEST_SUFFIX = /(Test|Tests|Spec)$/;
const TEST_QUALIFIER = /(Exhaustive|Integration|Unit|Robolectric|Compose|Ui|Property|Contract|Fake|Impl)$/;

/** `DefaultCallStateReducer`, `CallStateReducerImpl` and `CallStateReducer` are the same unit. */
function normalize(name: string): string {
  return name.replace(/^(Default|Real|Base)(?=[A-Z])/, "").replace(/Impl$/, "");
}

/** What the module's tests touch: test class bases (by name) and every identifier used. */
export interface TestIndex {
  bases: Set<string>;
  identifiers: Set<string>;
}

export function indexTests(testFiles: string[]): TestIndex {
  const bases = new Set<string>();
  const identifiers = new Set<string>();
  for (const file of testFiles) {
    const text = readFileSync(file, "utf8");
    for (const c of declaredClasses(text)) {
      if (!TEST_SUFFIX.test(c.name)) continue;
      let base = c.name.replace(TEST_SUFFIX, "");
      bases.add(normalize(base));
      while (TEST_QUALIFIER.test(base)) {
        base = base.replace(TEST_QUALIFIER, "");
        bases.add(normalize(base));
      }
    }
    for (const id of text.matchAll(/\b[A-Z]\w+\b/g)) identifiers.add(id[0]);
  }
  return { bases, identifiers };
}

function testLink(name: string, index: TestIndex): TestLink {
  if (index.bases.has(normalize(name))) return "direct";
  if (index.identifiers.has(name)) return "referenced";
  return "none";
}

export function inventory(projectRoot: string, mainFiles: string[], tests: TestIndex): ClassInfo[] {
  const out: ClassInfo[] = [];
  for (const file of mainFiles) {
    const text = readFileSync(file, "utf8");
    const declared = declaredClasses(text).filter((c) => !c.modifiers.includes("private"));
    if (declared.length === 0) continue;
    const lines = Math.max(1, Math.round(text.split("\n").length / declared.length));
    for (const c of declared) {
      const kind = classify(c, text);
      const test = testLink(c.name, tests);
      const weight = KIND_WEIGHT[kind];
      out.push({
        name: c.name,
        file: relative(projectRoot, file).replace(/\\/g, "/"),
        kind,
        lines,
        test,
        risk: Math.round(weight * Math.log2(lines + 1) * 10) / 10,
      });
    }
  }
  return out;
}
