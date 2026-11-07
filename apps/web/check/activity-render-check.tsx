/**
 * Render check for the head's activity screen components, run with Bun (TSX without a build step):
 *   bun apps/web/check/activity-render-check.tsx
 * Real React; assertions on what a person reads and what a screen reader hears. The screen itself (router, network,
 * paging state) is glue over these components and is NOT covered here.
 */
import assert from "node:assert/strict";
import { createElement } from "react";

// biome-ignore lint: Bun-only global
const bun = (globalThis as unknown as { Bun: { plugin: (p: unknown) => void } }).Bun;
bun.plugin({
  name: "router-stub",
  setup(build: { module: (name: string, cb: () => unknown) => void }) {
    build.module("react-router", () => ({
      loader: "object",
      exports: {
        Link: ({ to, children, ...rest }: { to: string; children: unknown }) => createElement("a", { href: to, ...rest }, children as never),
      },
    }));
  },
});

const { renderToStaticMarkup } = await import("react-dom/server");
const views = await import("../src/components/activity-views.tsx");
const lib = await import("../src/lib/activity.ts");
const { assertAccessible, text } = await import("./a11y.ts");

let passed = 0;
const check = (name: string, fn: () => void) => {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
};
const noop = () => {};
const ME = "00000000-0000-4000-8000-000000000011";
const OTHER = "00000000-0000-4000-8000-000000000012";
const CLASS = "00000000-0000-4000-8000-000000000101";
const item = (over: Record<string, unknown> = {}) => ({
  id: "10", at: "2026-10-19T06:05:00.000Z", actor: { id: ME, name: "Mrs. Moyo" }, category: "classes" as const, summary: "Created a class", detail: "Grade 9A",
  entity: { type: "class", id: CLASS }, ...over,
});
const HARARE = "Africa/Harare";

check("filter bar: four labelled controls, dates named From and To, errors tied to their field", () => {
  const html = renderToStaticMarkup(
    <views.ActivityFilterBar values={lib.emptyActivityFilters()} errors={{}} people={[{ value: ME, label: "Mrs. Moyo" }]} filtered={false} onChange={noop} onClear={noop} />,
  );
  const t = text(html);
  for (const label of ["Kind of change", "Done by", "From", "To"]) assert.ok(t.includes(label), `missing ${label}`);
  assert.ok(html.includes('role="search"'));
  assert.ok(t.includes("Everything") && t.includes("Anyone") && t.includes("Mrs. Moyo"));
  for (const k of ["Students", "Classes", "Attendance", "Staff", "School settings"]) assert.ok(t.includes(k), k);
  assert.equal((html.match(/type="date"/g) ?? []).length, 2);
  assert.ok(!t.includes("Show everything again"), "nothing to clear yet");
  assertAccessible(html, "ActivityFilterBar");
  const bad = renderToStaticMarkup(
    <views.ActivityFilterBar values={{ ...lib.emptyActivityFilters(), from: "2026-10-09", to: "2026-10-08" }} errors={{ from: "The start date is after the end date." }} people={[]} filtered onChange={noop} onClear={noop} />,
  );
  assert.ok(bad.includes('aria-invalid="true"') && text(bad).includes("The start date is after the end date.") && text(bad).includes("Show everything again"));
  assertAccessible(bad, "ActivityFilterBar errors");
});

check("an entry: what was done, who did it and when (in the school's time), the detail, and a way to open it", () => {
  const html = renderToStaticMarkup(<ul><views.ActivityEntry item={item()} timeZone={HARARE} youUserId={OTHER} /></ul>);
  const t = text(html);
  assert.ok(t.includes("Created a class") && t.includes("Classes") && t.includes("Mrs. Moyo at 08:05") && t.includes("Grade 9A"));
  assert.ok(html.includes(`href="/classes/${CLASS}"`) && t.includes("Open class"));
  assertAccessible(html, "ActivityEntry");
  const mine = renderToStaticMarkup(<ul><views.ActivityEntry item={item()} timeZone={HARARE} youUserId={ME} /></ul>);
  assert.ok(text(mine).includes("You at 08:05") && !text(mine).includes("Mrs. Moyo"));
});

check("an entry with no detail and nothing to open shows just what happened", () => {
  const html = renderToStaticMarkup(<ul><views.ActivityEntry item={item({ detail: null, summary: "Made a change", category: "other", entity: { type: "thing", id: null } })} timeZone={HARARE} youUserId={OTHER} /></ul>);
  const t = text(html);
  assert.ok(t.includes("Made a change") && t.includes("Other"));
  assert.ok(!html.includes("<a "), "no link where there is nowhere to go");
});

check("the list: one labelled section per day with the day as its heading, newest first", () => {
  const days = lib.groupByDay(
    [item({ id: "3", at: "2026-10-19T09:00:00.000Z" }), item({ id: "2", at: "2026-10-18T09:00:00.000Z" }), item({ id: "1", at: "2026-10-12T09:00:00.000Z" })],
    HARARE, new Date("2026-10-19T10:00:00.000Z"),
  );
  const html = renderToStaticMarkup(<views.ActivityList days={days} timeZone={HARARE} youUserId={OTHER} filtered={false} />);
  assert.deepEqual([...html.matchAll(/<h2[^>]*>([^<]+)<\/h2>/g)].map((m) => m[1]), ["Today", "Yesterday", "Monday 12 October"]);
  assert.equal((html.match(/<section\b/g) ?? []).length, 3);
  for (const h of ["Today", "Yesterday", "Monday 12 October"]) assert.ok(html.includes(`aria-label="${h}"`));
  assertAccessible(html, "ActivityList");
});

check("an empty list says whether it is empty or filtered, and what to do", () => {
  const none = text(renderToStaticMarkup(<views.ActivityList days={[]} timeZone={HARARE} youUserId={ME} filtered={false} />));
  assert.ok(none.includes("No activity yet") && none.includes("will appear here as they happen"));
  const filtered = text(renderToStaticMarkup(<views.ActivityList days={[]} timeZone={HARARE} youUserId={ME} filtered />));
  assert.ok(filtered.includes("Nothing matches") && filtered.includes("Try a different kind of change"));
});

check("older activity: a button while there is more, a working state, an error read out, and an honest end", () => {
  const more = renderToStaticMarkup(<views.OlderActivity hasMore busy={false} error={null} shown={30} onMore={noop} />);
  assert.ok(text(more).includes("Show older activity") && !/disabled=""/.test(more));
  const busy = renderToStaticMarkup(<views.OlderActivity hasMore busy error={null} shown={30} onMore={noop} />);
  assert.ok(/<button[^>]*disabled=""/.test(busy) && text(busy).includes("Loading…"));
  const failed = renderToStaticMarkup(<views.OlderActivity hasMore busy={false} error="No connection to the server." shown={30} onMore={noop} />);
  assert.ok(failed.includes('role="alert"') && text(failed).includes("No connection to the server."));
  assert.ok(text(renderToStaticMarkup(<views.OlderActivity hasMore={false} busy={false} error={null} shown={31} onMore={noop} />)).includes("That is everything: 31 entries."));
  assert.ok(text(renderToStaticMarkup(<views.OlderActivity hasMore={false} busy={false} error={null} shown={1} onMore={noop} />)).includes("1 entry."));
  assert.equal(renderToStaticMarkup(<views.OlderActivity hasMore={false} busy={false} error={null} shown={0} onMore={noop} />), "<div class=\"space-y-2 pt-2\"></div>");
});

console.log(`\n${passed} activity render checks passed`);
