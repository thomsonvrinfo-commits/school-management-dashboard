/**
 * Optional smoke check for the presentational components, run with Bun (it understands TSX without a build step):
 *   bun apps/web/check/render-check.tsx
 * It renders each component to HTML with real React and asserts on what a person would read and what a screen reader would hear.
 */
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import type { AttendanceSummaryResponse } from "@schoolpulse/contracts";
import { CountsBar, RegisterList } from "../src/components/attendance.tsx";
import { SummaryView } from "../src/components/summary.tsx";
import { SyncBadgeView } from "../src/components/sync-badge-view.tsx";
import { syncState } from "@schoolpulse/sync";

let passed = 0;
const check = (name: string, fn: () => void) => {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
};
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

const students = [
  { id: "s1", firstName: "Tadiwa", lastName: "Mbewe", admissionNo: "MA1001" },
  { id: "s2", firstName: "Nyasha", lastName: "Moyo", admissionNo: "MA1002" },
];

check("register: every pupil gets Present, Late and Absent buttons with spoken names", () => {
  const html = renderToStaticMarkup(<RegisterList students={students} marks={{ s1: "absent" }} waiting={new Set(["s1"])} onMark={() => {}} />);
  assert.equal((html.match(/<button/g) ?? []).length, 6);
  assert.ok(html.includes('aria-label="Absent: Tadiwa Mbewe"'));
  assert.ok(html.includes('aria-label="Present: Nyasha Moyo"'));
});

check("register: only the chosen status is pressed, and unsynced marks say so in words", () => {
  const html = renderToStaticMarkup(<RegisterList students={students} marks={{ s1: "absent" }} waiting={new Set(["s1"])} onMark={() => {}} />);
  const pressed = [...html.matchAll(/aria-pressed="true"[^>]*aria-label="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(pressed, ["Absent: Tadiwa Mbewe"]);
  assert.ok(text(html).includes("MA1001 Waiting to sync"));
  assert.ok(!text(html).includes("MA1002 Waiting to sync"));
});

check("counts bar shows all four counts", () => {
  const t = text(renderToStaticMarkup(<CountsBar counts={{ present: 9, late: 2, absent: 1, unmarked: 0 }} />));
  assert.equal(t, "Present 9 Late 2 Absent 1 Not marked 0");
});

check("sync badge: the label a teacher reads in each state", () => {
  const label = (s: ReturnType<typeof syncState>) => text(renderToStaticMarkup(<SyncBadgeView state={s} />));
  assert.equal(label(syncState({ online: true, queue: [], syncing: false })), "Synced");
  assert.equal(label(syncState({ online: false, queue: [], syncing: false })), "Offline");
});

const figures = (present: number, late: number, absent: number) => {
  const total = present + late + absent;
  const attended = present + late;
  return { present, late, absent, total, attended, rate: total === 0 ? null : Math.round((attended / total) * 1000) / 10 };
};
const summary: AttendanceSummaryResponse = {
  period: { from: "2026-10-02", to: "2026-10-08" },
  previousPeriod: { from: "2026-09-25", to: "2026-10-01" },
  school: figures(1836, 102, 168),
  previousSchool: figures(1900, 90, 116),
  changePoints: -2.1,
  classes: [
    { classId: "c1", name: "Grade 6A", current: figures(48, 1, 1), previous: figures(47, 1, 2), changePoints: 2 },
    { classId: "c2", name: "Grade 7B", current: figures(30, 5, 15), previous: figures(46, 2, 2), changePoints: -22 },
    { classId: "c3", name: "Grade 5A", current: figures(0, 0, 0), previous: figures(0, 0, 0), changePoints: null },
  ],
};

check("head overview: the headline number, the change in words, and how it was worked out", () => {
  const t = text(renderToStaticMarkup(<SummaryView data={summary} />));
  assert.ok(t.includes("92%"), t);
  assert.ok(t.includes("▼ down 2.1 points on the previous period"), t);
  assert.ok(t.includes("1,836 present plus 102 late is 1,938 in school, out of 2,106 register entries"), t);
  assert.ok(t.includes("168 entries marked absent"), t);
});

check("head overview: classes sorted with the biggest drop first; empty class says so", () => {
  const html = renderToStaticMarkup(<SummaryView data={summary} />);
  const order = [...html.matchAll(/font-semibold">(Grade [0-9A-Z]+)</g)].map((m) => m[1]);
  assert.deepEqual(order, ["Grade 7B", "Grade 6A", "Grade 5A"]);
  const t = text(html);
  assert.ok(t.includes("No registers in this period."));
  assert.ok(t.includes("down 22 points on the previous period"));
});

check("head overview: with no records the headline is words, never 0%", () => {
  const empty: AttendanceSummaryResponse = { ...summary, school: figures(0, 0, 0), previousSchool: figures(0, 0, 0), changePoints: null, classes: [] };
  const t = text(renderToStaticMarkup(<SummaryView data={empty} />));
  assert.ok(t.includes("No registers yet"));
  assert.ok(!t.includes("0%"));
  assert.ok(t.includes("Nothing to compare with"));
  assert.ok(t.includes("No register entries were recorded in this period."));
});

console.log(`\n${passed} render checks passed`);
