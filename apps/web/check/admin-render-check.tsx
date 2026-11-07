/**
 * Render check for the school-administration (Slice 2) components, run with Bun (TSX without a build step):
 *   bun apps/web/check/admin-render-check.tsx
 * It renders each presentational component with real React and asserts on what a person would read and what a screen
 * reader would hear: every control has a label, errors are tied to their field, destructive actions ask first.
 *
 * react-router is replaced by a two-line stub so the check runs the same whether or not it is installed. The screens
 * (which use the router and the network) are glue over these components and are NOT covered here.
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
const forms = await import("../src/components/admin-forms.tsx");
const views = await import("../src/components/admin-views.tsx");
const ui = await import("../src/components/ui.tsx");
const f = await import("../src/lib/admin-forms.ts");
const { assertAccessible, text } = await import("./a11y.ts");

let passed = 0;
const check = (name: string, fn: () => void) => {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
};
const noop = () => {};
const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const classes = [
  { id: UUID(1), name: "Grade 4A", academicYear: { name: "2026" } },
  { id: UUID(2), name: "Grade 4B", academicYear: null },
];
const formProps = { errors: {}, busy: false, onChange: noop, onSubmit: noop, submitLabel: "Save" };

check("text field: label, hint and error are tied to the control", () => {
  const html = renderToStaticMarkup(<ui.TextField label="Admission number" required value="" onChange={noop} error="Enter the admission number." hint="Unique in this school." />);
  assert.ok(html.includes("Admission number"));
  assert.ok(html.includes("(required)"));
  assert.ok(html.includes('aria-invalid="true"'));
  const id = /<input[^>]*\bid="([^"]+)"/.exec(html)![1];
  assert.ok(html.includes(`aria-describedby="${id}-hint ${id}-error"`));
  assert.ok(text(html).includes("Enter the admission number."));
  assertAccessible(html, "TextField");
});

check("student form (register): every field labelled, class picker offered, errors beside fields", () => {
  const values = { ...f.emptyStudentForm(), classId: UUID(1) };
  const html = renderToStaticMarkup(<forms.StudentForm {...formProps} mode="create" classes={classes} values={values}
    errors={{ admissionNo: "Enter the admission number.", firstName: "Enter the first name." }} banner="That was not saved. Fix the highlighted fields and try again." />);
  const t = text(html);
  for (const label of ["Admission number", "First name", "Last name", "Other names", "Date of birth", "Gender", "Enrolment date", "Put in class", "First day in the class"]) assert.ok(t.includes(label), `missing ${label}`);
  assert.ok(html.includes('role="alert"'), "the banner is announced");
  assert.equal((html.match(/aria-invalid="true"/g) ?? []).length, 2);
  assert.ok(t.includes("Grade 4A (2026)") && t.includes("Grade 4B"), "classes show their year when they have one");
  assertAccessible(html, "StudentForm create");
});

check("student form (edit): no class fields, because moving a student is its own dated action", () => {
  const html = renderToStaticMarkup(<forms.StudentForm {...formProps} mode="edit" classes={classes} values={f.emptyStudentForm()} />);
  assert.ok(!text(html).includes("Put in class"));
  assert.ok(text(html).includes("Cannot be moved after the student's first class placement."));
  assertAccessible(html, "StudentForm edit");
});

check("the start date for a class only appears once a class is chosen", () => {
  const without = text(renderToStaticMarkup(<forms.StudentForm {...formProps} mode="create" classes={classes} values={f.emptyStudentForm()} />));
  assert.ok(!without.includes("First day in the class"));
});

check("move form: the class the student is already in is not offered; the date explains itself", () => {
  const html = renderToStaticMarkup(<forms.PlacementForm {...formProps} classes={classes} currentClassId={UUID(1)} values={{ classId: "", effectiveFrom: "" }} />);
  assert.ok(!html.includes("Grade 4A"), "current class excluded");
  assert.ok(html.includes("Grade 4B"));
  assert.ok(text(html).includes("Leave blank for tomorrow."));
  assertAccessible(html, "PlacementForm");
});

check("status form: the current status is not offered; every other status is", () => {
  const html = renderToStaticMarkup(<forms.StatusForm {...formProps} currentStatus="enrolled" values={{ status: "", effectiveFrom: "" }} />);
  const t = text(html);
  assert.ok(!/>Enrolled</.test(html));
  for (const s of ["Withdrawn", "Transferred out", "Graduated"]) assert.ok(t.includes(s), s);
  assertAccessible(html, "StatusForm");
});

check("class form: year chooser, locked with a reason when the class already has students", () => {
  const years = [{ id: UUID(9), name: "2026" }];
  const open = renderToStaticMarkup(<forms.ClassForm {...formProps} mode="create" years={years} values={f.emptyClassForm(UUID(9))} />);
  assertAccessible(open, "ClassForm create");
  const locked = renderToStaticMarkup(<forms.ClassForm {...formProps} mode="edit" years={years} yearLocked values={f.emptyClassForm(UUID(9))} />);
  assert.ok(/<select[^>]*disabled=""/.test(locked));
  assert.ok(text(locked).includes("Fixed once a class has students or registers."));
  assertAccessible(locked, "ClassForm edit");
});

check("school profile, year and term forms are fully labelled", () => {
  const profile = renderToStaticMarkup(<forms.ProfileForm {...formProps} values={{ name: "Mavambo", code: "", timezone: "Africa/Harare", contactEmail: "", contactPhone: "", address: "" }} />);
  assert.ok(profile.includes('<option value="Africa/Harare">'), "time zone suggestions");
  assertAccessible(profile, "ProfileForm");
  assertAccessible(renderToStaticMarkup(<forms.YearForm {...formProps} mode="create" values={f.emptyYearForm()} />), "YearForm");
  assertAccessible(renderToStaticMarkup(<forms.TermForm {...formProps} mode="create" values={f.emptyTermForm()} />), "TermForm");
});

check("a busy form cannot be submitted twice and says so", () => {
  const html = renderToStaticMarkup(<forms.ClassForm {...formProps} busy mode="create" years={[]} values={f.emptyClassForm()} />);
  assert.ok(/<button[^>]*type="submit"[^>]*disabled=""/.test(html));
  assert.ok(html.includes('aria-busy="true"'));
  assert.ok(text(html).includes("Saving…"));
});

check("student list: name, admission number and class on one row; no-class and upcoming moves in words", () => {
  const items = [
    { id: UUID(1), admissionNo: "MA1001", firstName: "Tadiwa", lastName: "Mbewe", status: "enrolled" as const, currentClass: { id: UUID(5), name: "Grade 7A" }, upcomingClass: null },
    { id: UUID(2), admissionNo: "MA1002", firstName: "Nyasha", lastName: "Moyo", status: "enrolled" as const, currentClass: null, upcomingClass: null },
    { id: UUID(3), admissionNo: "MA1003", firstName: "Rudo", lastName: "Dube", status: "enrolled" as const, currentClass: { id: UUID(5), name: "Grade 7A" }, upcomingClass: { id: UUID(6), name: "Grade 7B", startsOn: "2026-10-09" } },
    { id: UUID(4), admissionNo: "MA1004", firstName: "Kuda", lastName: "Sibanda", status: "withdrawn" as const, currentClass: null, upcomingClass: null },
  ];
  const html = renderToStaticMarkup(<views.StudentRows items={items} />);
  const t = text(html);
  assert.ok(t.includes("Tadiwa Mbewe MA1001 · Grade 7A"));
  assert.ok(t.includes("MA1002 · No class yet"));
  assert.ok(t.includes("moving to Grade 7B on 9 Oct 2026"));
  assert.ok(t.includes("MA1004 · Not in a class Withdrawn"), t);
  assert.ok(html.includes(`href="/students/${UUID(1)}"`));
  assert.ok(!t.includes("Enrolled"), "enrolled is the normal state and is not repeated on every row");
  assert.ok(text(renderToStaticMarkup(<views.StudentRows items={[]} />)).includes("No students match"));
});

check("student filters: search, status and class are labelled; the 'no class' checkbox has a label", () => {
  const html = renderToStaticMarkup(<views.StudentFilterBar draft="tad" applied={{ q: "", status: "", classId: "", unplaced: false }} classes={classes} onDraft={noop} onSearch={noop} onApply={noop} />);
  assert.ok(html.includes('role="search"'));
  assert.ok(text(html).includes("Search by name or admission number"));
  assert.ok(text(html).includes("Only enrolled students who are not in a class yet"));
  assert.ok(html.includes('value="tad"'));
  assertAccessible(html.replace(/<label class="flex[^>]*>[\s\S]*?<\/label>/, ""), "StudentFilterBar");
});

check("placement history: newest first, only the latest can be removed, and the button says which class", () => {
  const placements = [
    { id: UUID(1), classId: UUID(5), className: "Grade 3A", academicYear: { id: UUID(8), name: "2025" }, startsOn: "2025-01-13", endsOn: "2025-12-12" },
    { id: UUID(2), classId: UUID(6), className: "Grade 4A", academicYear: { id: UUID(9), name: "2026" }, startsOn: "2026-01-12", endsOn: null },
  ];
  const html = renderToStaticMarkup(<views.PlacementList placements={placements} removableId={UUID(2)} onRemove={noop} />);
  assert.ok(html.indexOf("Grade 4A") < html.indexOf("Grade 3A"), "newest first");
  assert.equal((html.match(/<button/g) ?? []).length, 1);
  assert.ok(html.includes('aria-label="Remove the placement in Grade 4A"'));
  assert.ok(text(html).includes("from 12 Jan 2026, still there"));
  assert.ok(text(renderToStaticMarkup(<views.PlacementList placements={[]} removableId={null} onRemove={noop} />)).includes("Not in any class yet"));
});

check("student facts: unrecorded fields say 'Not recorded' instead of being blank", () => {
  const s = { id: UUID(1), admissionNo: "MA1", firstName: "A", lastName: "B", status: "enrolled" as const, currentClass: null, upcomingClass: null, otherNames: null, dateOfBirth: null, gender: null, enrolmentDate: "2026-01-12", placements: [], attendance: [] };
  const t = text(renderToStaticMarkup(<views.StudentFacts student={s} />));
  assert.ok(t.includes("Date of birth Not recorded") && t.includes("Gender Not recorded") && t.includes("Class today No class"), t);
  assert.ok(!t.includes("Other names"));
});

check("registers taken: per class, with the count in words", () => {
  const t = text(renderToStaticMarkup(<views.AttendanceByClass rows={[{ classId: UUID(1), className: "Grade 3A", days: 1, lastDate: "2025-12-12" }, { classId: UUID(2), className: "Grade 4A", days: 20, lastDate: null }]} />));
  assert.ok(t.includes("Grade 3A: 1 day recorded, last on 12 Dec 2025"));
  assert.ok(t.includes("Grade 4A: 20 days recorded"));
  assert.ok(text(renderToStaticMarkup(<views.AttendanceByClass rows={[]} />)).includes("No registers have been taken"));
});

check("class list: archived and year-less classes are flagged, counts use the right plural", () => {
  const items = [
    { id: UUID(1), name: "Grade 7A", gradeLevel: "7", stream: "A", status: "active" as const, academicYear: { id: UUID(9), name: "2026" }, studentCount: 1, teacherCount: 2 },
    { id: UUID(2), name: "Grade 5A", gradeLevel: "5", stream: null, status: "archived" as const, academicYear: null, studentCount: 0, teacherCount: 0 },
  ];
  const html = renderToStaticMarkup(<views.ClassRows items={items} />);
  const t = text(html);
  assert.ok(t.includes("Grade 7 · Stream A · 2026"));
  assert.ok(t.includes("1 student · 2 teachers"));
  assert.ok(t.includes("No academic year yet") && t.includes("0 students · 0 teachers"));
  assert.equal((html.match(/Archived/g) ?? []).length, 1);
  assert.ok(html.includes(`href="/classes/${UUID(1)}"`));
});

const chipo = { id: UUID(20), name: "Ms. Chipo" };
const tendai = { id: UUID(21), name: "Mr. Tendai", email: "t@x", classCount: 1 };

check("teacher panel: remove buttons name the teacher; the picker offers only unassigned teachers", () => {
  const html = renderToStaticMarkup(<views.TeacherPanel assigned={[chipo]} available={[tendai]} selected="" onSelect={noop} onAssign={noop} onRemove={noop} busy={false} />);
  assert.ok(html.includes('aria-label="Remove Ms. Chipo from this class"'));
  assert.ok(text(html).includes("Mr. Tendai (1 class)"));
  assert.ok(!html.includes(">Ms. Chipo (")); // not offered again
  assert.ok(/<button[^>]*disabled=""[^>]*>Add<\/button>/.test(html), "Add is disabled until a teacher is chosen");
  assertAccessible(html, "TeacherPanel");
});

check("teacher panel: nobody assigned says what that means; an archived class explains why it is read-only", () => {
  const empty = text(renderToStaticMarkup(<views.TeacherPanel assigned={[]} available={[tendai]} selected="" onSelect={noop} onAssign={noop} onRemove={noop} busy={false} />));
  assert.ok(empty.includes("nobody can take this class's register"));
  const blocked = renderToStaticMarkup(<views.TeacherPanel assigned={[chipo]} available={[tendai]} selected="" onSelect={noop} onAssign={noop} onRemove={noop} busy={false} blockedReason="This class is archived. Reactivate it before assigning teachers." />);
  assert.ok(text(blocked).includes("Reactivate it before assigning teachers."));
  assert.ok(!blocked.includes("<select"));
  assert.ok(text(renderToStaticMarkup(<views.TeacherPanel assigned={[chipo]} available={[]} selected="" onSelect={noop} onAssign={noop} onRemove={noop} busy={false} />)).includes("already assigned"));
});

check("roster: each student links to their page; an empty class says so with the date", () => {
  const roster = { classId: UUID(1), className: "Grade 7A", gradeLevel: "7", stream: "A", academicYear: null, date: "2026-10-08", students: [{ id: UUID(3), classId: UUID(1), admissionNo: "MA1001", firstName: "Tadiwa", lastName: "Mbewe" }] };
  const html = renderToStaticMarkup(<views.RosterList roster={roster} />);
  assert.ok(html.includes(`href="/students/${UUID(3)}"`) && text(html).includes("Tadiwa Mbewe MA1001"));
  assert.ok(text(renderToStaticMarkup(<views.RosterList roster={{ ...roster, students: [] }} />)).includes("No students in Grade 7A on 8 Oct 2026"));
});

check("year card: the current year is marked and cannot be 'made current'; terms are in date order; every button names its target", () => {
  const year = {
    id: UUID(1), name: "2026", startsOn: "2026-01-05", endsOn: "2026-12-11", isActive: true, classCount: 3,
    terms: [
      { id: UUID(3), academicYearId: UUID(1), name: "Term 2", startsOn: "2026-05-04", endsOn: "2026-08-07" },
      { id: UUID(2), academicYearId: UUID(1), name: "Term 1", startsOn: "2026-01-12", endsOn: "2026-04-10" },
    ],
  };
  const html = renderToStaticMarkup(<ul><views.YearCard year={year} onEdit={noop} onDelete={noop} onMakeCurrent={noop} onAddTerm={noop} onEditTerm={noop} onDeleteTerm={noop} /></ul>);
  assert.ok(text(html).includes("Current year") && text(html).includes("3 classes"));
  assert.ok(!html.includes("Make 2026 the current year"));
  assert.ok(html.indexOf("Term 1") < html.indexOf("Term 2"));
  assert.ok(html.includes('aria-label="Delete Term 1, 2026"'));
  assertAccessible(html, "YearCard");
  const other = renderToStaticMarkup(<ul><views.YearCard year={{ ...year, isActive: false, terms: [] }} onEdit={noop} onDelete={noop} onMakeCurrent={noop} onAddTerm={noop} onEditTerm={noop} onDeleteTerm={noop} /></ul>);
  assert.ok(other.includes('aria-label="Make 2026 the current year"') && text(other).includes("No terms added yet."));
});

check("confirm dialog: announced as an alert dialog, labelled and described, with the safe choice first", () => {
  const html = renderToStaticMarkup(<ui.ConfirmDialog title="Delete 2026?" confirmLabel="Delete" danger onConfirm={noop} onCancel={noop}><p>It cannot be undone.</p></ui.ConfirmDialog>);
  assert.ok(html.includes('role="alertdialog"') && html.includes('aria-modal="true"'));
  const labelled = /aria-labelledby="([^"]+)"/.exec(html)![1];
  const described = /aria-describedby="([^"]+)"/.exec(html)![1];
  assert.ok(html.includes(`id="${labelled}"`) && html.includes(`id="${described}"`));
  assert.ok(html.indexOf("Cancel") < html.indexOf(">Delete<"), "Cancel comes before the destructive button");
  assert.ok(html.includes("bg-absent"), "the destructive button looks destructive");
});

check("confirm dialog: while working both buttons are disabled; a refusal is read out", () => {
  const html = renderToStaticMarkup(<ui.ConfirmDialog title="t" confirmLabel="Delete" busyLabel="Deleting…" busy error="A year that has classes cannot be deleted." onConfirm={noop} onCancel={noop}>x</ui.ConfirmDialog>);
  assert.equal((html.match(/<button[^>]*disabled=""/g) ?? []).length, 2);
  assert.ok(text(html).includes("Deleting…"));
  assert.ok(html.includes('role="alert"') && text(html).includes("cannot be deleted"));
});

check("pager: says where you are and disables the end that is not available", () => {
  const html = renderToStaticMarkup(<ui.Pager from={26} to={50} total={132} hasPrev hasNext={false} onPrev={noop} onNext={noop} noun="students" />);
  assert.ok(text(html).includes("Showing 26 to 50 of 132"));
  assert.ok(/<button[^>]*disabled=""[^>]*>Next<\/button>/.test(html));
  assert.ok(!/<button[^>]*disabled=""[^>]*>Previous<\/button>/.test(html));
  assert.ok(text(renderToStaticMarkup(<ui.Pager from={0} to={0} total={0} hasPrev={false} hasNext={false} onPrev={noop} onNext={noop} noun="students" />)).includes("No students"));
});

check("notices: errors interrupt, everything else is polite", () => {
  assert.ok(renderToStaticMarkup(<ui.Notice tone="error">x</ui.Notice>).includes('role="alert"'));
  assert.ok(renderToStaticMarkup(<ui.Notice tone="success">x</ui.Notice>).includes('role="status"'));
});

console.log(`\n${passed} admin render checks passed`);
