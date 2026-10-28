/** A unified diff of two texts, for showing a drafted change. Line based, three lines of context. */
export function unifiedDiff(before: string, after: string, path: string, context = 3): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const ops = lineOps(a, b);
  if (!ops.some((o) => o.op !== " ")) return "";

  // Changes closer than two contexts apart share a hunk.
  const changed = ops.flatMap((o, k) => (o.op === " " ? [] : [k]));
  const groups: [number, number][] = [];
  for (const k of changed) {
    const last = groups[groups.length - 1];
    if (last && k - last[1] <= context * 2) last[1] = k;
    else groups.push([k, k]);
  }

  const out = [`--- a/${path}`, `+++ b/${path}`];
  for (const [first, last] of groups) {
    const hunk = ops.slice(Math.max(0, first - context), Math.min(ops.length, last + context + 1));
    const aLen = hunk.filter((o) => o.op !== "+").length;
    const bLen = hunk.filter((o) => o.op !== "-").length;
    out.push(`@@ -${hunk[0]!.a + 1},${aLen} +${hunk[0]!.b + 1},${bLen} @@`);
    for (const o of hunk) out.push(`${o.op}${o.text}`);
  }
  return out.join("\n");
}

interface LineOp {
  op: " " | "-" | "+";
  text: string;
  /** Line index in each text where this op starts. */
  a: number;
  b: number;
}

/** Longest common subsequence over lines, after trimming the shared head and tail. */
function lineOps(a: string[], b: string[]): LineOp[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);

  const n = midA.length;
  const m = midB.length;
  // Too big to align line by line: show the middle as replaced rather than run out of memory.
  if (n * m > 4_000_000) {
    return [
      ...a.slice(0, head).map((text, k) => ({ op: " " as const, text, a: k, b: k })),
      ...midA.map((text, k) => ({ op: "-" as const, text, a: head + k, b: head })),
      ...midB.map((text, k) => ({ op: "+" as const, text, a: head + n, b: head + k })),
      ...a.slice(a.length - tail).map((text, k) => ({ op: " " as const, text, a: head + n + k, b: head + m + k })),
    ];
  }
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = midA[i] === midB[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);

  const ops: LineOp[] = [];
  for (let k = 0; k < head; k++) ops.push({ op: " ", text: a[k]!, a: k, b: k });
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && midA[i] === midB[j]) ops.push({ op: " ", text: midA[i]!, a: head + i++, b: head + j++ });
    // On a tie the removal goes first, so a changed line reads "-old" then "+new".
    else if (j < m && (i >= n || lcs[i]![j + 1]! > lcs[i + 1]![j]!)) ops.push({ op: "+", text: midB[j]!, a: head + i, b: head + j++ });
    else ops.push({ op: "-", text: midA[i]!, a: head + i++, b: head + j });
  }
  for (let k = 0; k < tail; k++) ops.push({ op: " ", text: a[a.length - tail + k]!, a: a.length - tail + k, b: b.length - tail + k });
  return ops;
}
