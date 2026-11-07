/** Helpers shared by the render checks: what a person would read, and what a screen reader would need. */
import assert from "node:assert/strict";

/** The visible text of some markup: tags dropped, entities undone, whitespace squeezed. */
export const text = (html: string): string =>
  html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").replace(/\s([:,.;])/g, "$1").trim();

/** Every input and select has a label that points at it; every button has a name a screen reader can speak. */
export function assertAccessible(html: string, where: string): void {
  const controls = [...html.matchAll(/<(input|select)\b[^>]*>/g)].map((m) => m[0]);
  for (const c of controls) {
    const id = /\bid="([^"]+)"/.exec(c)?.[1];
    assert.ok(id, `${where}: control without an id: ${c}`);
    assert.ok(new RegExp(`<label[^>]*for="${id}"`).test(html), `${where}: no <label for="${id}"> for ${c}`);
  }
  for (const m of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
    const named = /aria-label="[^"]+"/.test(m[1] ?? "") || text(m[2] ?? "").length > 0;
    assert.ok(named, `${where}: a button has no name: ${m[0]}`);
  }
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, `${where}: duplicate ids ${ids.join(",")}`);
  for (const m of html.matchAll(/aria-describedby="([^"]+)"/g)) {
    for (const ref of (m[1] ?? "").split(" ")) assert.ok(ids.includes(ref), `${where}: aria-describedby points at missing id ${ref}`);
  }
}
