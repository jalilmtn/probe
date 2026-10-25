/** One on-screen element from a uiautomator dump, reduced to what an agent needs to act. */
export interface UiElement {
  index: number;
  text: string;
  desc: string;
  id: string;
  cls: string;
  clickable: boolean;
  enabled: boolean;
  focused: boolean;
  checked: boolean;
  scrollable: boolean;
  password: boolean;
  center: [number, number];
  bounds: [number, number, number, number];
}

/**
 * Parses `uiautomator dump` XML. Keeps elements that say something (text, description, id)
 * or can be acted on, so a Compose screen becomes a short numbered list instead of a tree.
 */
export function parseUiTree(xml: string): UiElement[] {
  const out: UiElement[] = [];
  for (const m of xml.matchAll(/<node\b([^>]*?)\/?>/g)) {
    const a = m[1]!;
    const get = (name: string) => decode(new RegExp(`\\b${name}="([^"]*)"`).exec(a)?.[1] ?? "");
    const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(get("bounds"));
    if (!b) continue;
    const bounds = [Number(b[1]), Number(b[2]), Number(b[3]), Number(b[4])] as UiElement["bounds"];
    if (bounds[2] - bounds[0] <= 1 || bounds[3] - bounds[1] <= 1) continue;
    const el: UiElement = {
      index: 0,
      text: get("text"),
      desc: get("content-desc"),
      id: get("resource-id").replace(/^.*:id\//, ""),
      cls: get("class").split(".").pop() ?? "",
      clickable: get("clickable") === "true" || get("long-clickable") === "true",
      enabled: get("enabled") !== "false",
      focused: get("focused") === "true",
      checked: get("checked") === "true",
      scrollable: get("scrollable") === "true",
      password: get("password") === "true",
      center: [Math.round((bounds[0] + bounds[2]) / 2), Math.round((bounds[1] + bounds[3]) / 2)],
      bounds,
    };
    if (el.text || el.desc || el.clickable || el.scrollable || el.cls === "EditText") out.push(el);
  }
  out.forEach((e, i) => (e.index = i + 1));
  return out;
}

export function formatUiTree(elements: UiElement[]): string {
  if (elements.length === 0) return "(no readable elements — the screen may be loading or drawn without accessibility info)";
  return elements
    .map((e) => {
      const text = e.password ? "••••" : e.text;
      const desc = e.desc && e.desc !== e.text ? e.desc : "";
      const flags = [
        e.clickable && "tap",
        e.scrollable && "scroll",
        e.cls === "EditText" && "input",
        e.focused && "focused",
        e.checked && "checked",
        !e.enabled && "disabled",
      ].filter(Boolean);
      return `[${e.index}] ${e.cls}${e.id ? ` #${e.id}` : ""} ${text ? `"${text.slice(0, 80)}"` : ""}${desc ? ` [${desc.slice(0, 80)}]` : ""}${flags.length ? ` (${flags.join(",")})` : ""} @${e.center.join(",")}`;
    })
    .join("\n");
}

function decode(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n: string) => (n === "10" ? " " : String.fromCodePoint(Number(n))))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}
