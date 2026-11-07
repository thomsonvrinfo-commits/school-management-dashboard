/**
 * Render check for the staff-onboarding (P1) components, run with Bun (TSX without a build step):
 *   bun apps/web/check/staff-render-check.tsx
 * Same idea as admin-render-check: real React, assertions on what a person reads and what a screen reader hears. It also
 * checks the things that matter for passwords and links: the right autocomplete hints, nothing secret in a visible
 * label, a link shown only with its warning.
 *
 * The screens themselves (router, network, clipboard) are glue over these components and are NOT covered here.
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
const views = await import("../src/components/staff-views.tsx");
const ui = await import("../src/components/ui.tsx");
const page = await import("../src/screens/link-page.tsx");
const f = await import("../src/lib/staff-forms.ts");
const { assertAccessible, text } = await import("./a11y.ts");

let passed = 0;
const check = (name: string, fn: () => void) => {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
};
const noop = () => {};
const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const formProps = { errors: {}, busy: false, onChange: noop, onSubmit: noop };

const chipo = { membershipId: UUID(1), userId: UUID(11), name: "Ms. Chipo", email: "chipo@mavambo.example", role: "teacher" as const, active: true, joinedAt: "2026-01-05T08:00:00.000Z" };
const head = { membershipId: UUID(2), userId: UUID(12), name: "Mrs. Moyo", email: "head@mavambo.example", role: "head" as const, active: true, joinedAt: "2026-01-01T08:00:00.000Z" };
const buttons = (html: string) => [...html.matchAll(/<button\b[^>]*>/g)].length;

check("password box: hidden by default, with a 'Show password' switch and the right autocomplete hint", () => {
  const html = renderToStaticMarkup(<ui.PasswordField label="Choose a password" required value="" onChange={noop} autoComplete="new-password" hint="At least 10 characters." />);
  assert.ok(/<input[^>]*type="password"/.test(html), "hidden while typing");
  assert.ok(html.includes('autoComplete="new-password"') || html.includes('autocomplete="new-password"'));
  assert.ok(text(html).includes("Show password"));
  assert.ok(/<input[^>]*type="checkbox"/.test(html), "the switch is a real checkbox");
  assert.ok(html.includes('autoCapitalize="none"') || html.includes('autocapitalize="none"'), "no capital letter forced on a phone");
  assertAccessible(html, "PasswordField");
  const err = renderToStaticMarkup(<ui.PasswordField label="Password" value="" onChange={noop} autoComplete="current-password" error="Enter your current password." />);
  assert.ok(err.includes('aria-invalid="true"') && text(err).includes("Enter your current password."));
  assertAccessible(err, "PasswordField error");
});

check("invite form: email and optional name, labelled, says nothing is emailed", () => {
  const html = renderToStaticMarkup(<views.InviteForm {...formProps} values={f.emptyInviteForm()} submitLabel="Make invitation link" onCancel={noop} />);
  const t = text(html);
  assert.ok(t.includes("Email address") && t.includes("(required)") && t.includes("Name"));
  assert.ok(t.includes("We do not send anything"), "the head must not expect an email to go out");
  assert.ok(t.includes("Make invitation link") && t.includes("Cancel"));
  assertAccessible(html, "InviteForm");
  const bad = renderToStaticMarkup(<views.InviteForm {...formProps} errors={{ email: "Enter a valid email address." }} banner="That was not saved. Fix the highlighted fields and try again." values={f.emptyInviteForm()} submitLabel="Go" />);
  assert.ok(bad.includes('role="alert"') && bad.includes('aria-invalid="true"'));
  assertAccessible(bad, "InviteForm errors");
});

check("staff row (teacher, access on): can be reset or switched off; every button names the person", () => {
  const html = renderToStaticMarkup(<ul><views.MemberRow member={chipo} youUserId={head.userId} onSwitchOff={noop} onSwitchOn={noop} onResetLink={noop} /></ul>);
  const t = text(html);
  assert.ok(t.includes("Ms. Chipo") && t.includes("chipo@mavambo.example") && t.includes("Teacher") && t.includes("Access on"));
  assert.ok(html.includes('aria-label="Make a password reset link for Ms. Chipo"'));
  assert.ok(html.includes('aria-label="Switch access off for Ms. Chipo"'));
  assert.ok(!html.includes("Switch access back on"));
  assert.ok(!t.includes("(you)"));
  assertAccessible(html, "MemberRow teacher");
});

check("staff row (teacher, access off): can only be switched back on, and says it is off in words", () => {
  const html = renderToStaticMarkup(<ul><views.MemberRow member={{ ...chipo, active: false }} youUserId={head.userId} onSwitchOff={noop} onSwitchOn={noop} onResetLink={noop} /></ul>);
  assert.ok(text(html).includes("Access off"), "status is words, not colour");
  assert.ok(html.includes('aria-label="Switch access back on for Ms. Chipo"'));
  assert.ok(!html.includes("password reset link") && !html.includes("Switch access off"));
  assert.equal(buttons(html), 1);
});

check("staff row (a head): no actions are offered, and it says who manages heads; your own row says (you)", () => {
  const other = renderToStaticMarkup(<ul><views.MemberRow member={head} youUserId={chipo.userId} onSwitchOff={noop} onSwitchOn={noop} onResetLink={noop} /></ul>);
  assert.equal(buttons(other), 0);
  assert.ok(text(other).includes("School head") && text(other).includes("managed by whoever runs SchoolPulse"));
  const me = renderToStaticMarkup(<ul><views.MemberRow member={head} youUserId={head.userId} onSwitchOff={noop} onSwitchOn={noop} onResetLink={noop} /></ul>);
  assert.ok(text(me).includes("(you)"));
  assert.equal(buttons(me), 0);
});

check("staff row: while something is happening the buttons are disabled", () => {
  const html = renderToStaticMarkup(<ul><views.MemberRow member={chipo} youUserId={head.userId} busy onSwitchOff={noop} onSwitchOn={noop} onResetLink={noop} /></ul>);
  assert.equal((html.match(/<button[^>]*disabled=""/g) ?? []).length, 2);
});

check("waiting invitation: who, how long is left, one-use warning, and both actions named", () => {
  const inv = { id: UUID(5), email: "new@mavambo.example", name: "Mr. Tendai", role: "teacher" as const, createdAt: "2026-10-08T06:00:00.000Z", expiresAt: "2026-10-15T06:00:00.000Z" };
  const html = renderToStaticMarkup(<ul><views.InvitationRow invitation={inv} now={new Date("2026-10-10T06:00:00.000Z")} onNewLink={noop} onWithdraw={noop} /></ul>);
  const t = text(html);
  assert.ok(t.includes("Mr. Tendai (new@mavambo.example)") && t.includes("Waiting") && t.includes("Link works once") && t.includes("5 days left"));
  assert.ok(html.includes('aria-label="Make a new link for Mr. Tendai (new@mavambo.example)"'));
  assert.ok(html.includes('aria-label="Withdraw the invitation for Mr. Tendai (new@mavambo.example)"'));
  assertAccessible(html, "InvitationRow");
  const noName = renderToStaticMarkup(<ul><views.InvitationRow invitation={{ ...inv, name: null }} now={new Date("2026-10-10T06:00:00.000Z")} onNewLink={noop} onWithdraw={noop} /></ul>);
  assert.ok(text(noName).includes("new@mavambo.example"));
});

check("link panel: the link is readable and labelled, with the 'shown only now' warning and a WhatsApp hand-over", () => {
  const link = "https://app.example/accept#token=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
  const message = f.invitationMessage("Mavambo Academy", link, "2026-10-15T06:00:00.000Z", "Africa/Harare");
  const html = renderToStaticMarkup(<views.LinkPanel heading="Link for Mr. Tendai" link={link} message={message} expiresAt="2026-10-15T06:00:00.000Z" copied={false} canShare={false} onCopy={noop} onShare={noop} onDone={noop} />);
  const t = text(html);
  assert.ok(t.includes("shown only now") && t.includes("works once") && t.includes("Anyone who has it can use it"));
  assert.ok(/<input[^>]*readOnly=""[^>]*value="https:\/\/app\.example\/accept#token=/.test(html) || /<input[^>]*value="https:\/\/app\.example\/accept#token=[^"]*"[^>]*readonly=""/.test(html), "the link sits in a read-only box");
  assert.ok(html.includes('href="https://wa.me/?text=') && html.includes('rel="noopener noreferrer"'));
  assert.ok(!t.includes("Share…"), "the system share sheet is only offered where it exists");
  assert.ok(t.includes("Copy link") && t.includes("Done"));
  assertAccessible(html, "LinkPanel");
  const copied = renderToStaticMarkup(<views.LinkPanel heading="h" link={link} message={message} expiresAt="2026-10-15T06:00:00.000Z" copied canShare onCopy={noop} onShare={noop} onDone={noop} />);
  assert.ok(text(copied).includes("Copied") && text(copied).includes("The link is copied") && text(copied).includes("Share…"));
});

check("accept form (new account): name, password twice, nothing pre-filled that is secret, new-password hints", () => {
  const preview = { schoolName: "Mavambo Academy", email: "new@mavambo.example", role: "teacher" as const, suggestedName: "Mr. Tendai", accountExists: false, expiresAt: "2026-10-15T06:00:00.000Z" };
  const html = renderToStaticMarkup(<views.AcceptForm {...formProps} preview={preview} values={f.emptyAcceptForm("Mr. Tendai")} submitLabel="Create my account" />);
  const t = text(html);
  for (const label of ["Your name", "Choose a password", "Type the password again", "Create my account"]) assert.ok(t.includes(label), `missing ${label}`);
  assert.ok(html.includes('value="Mr. Tendai"'), "the head's suggested name is offered");
  assert.equal((html.match(/autoComplete="new-password"|autocomplete="new-password"/g) ?? []).length, 2);
  assert.ok(!html.includes("current-password"));
  assert.ok(t.includes("At least 10 characters"));
  assertAccessible(html, "AcceptForm new");
});

check("accept form (existing account): only the current password is asked for, and the person is told it stays the same", () => {
  const preview = { schoolName: "Mavambo Academy", email: "tendai@other.example", role: "teacher" as const, suggestedName: null, accountExists: true, expiresAt: "2026-10-15T06:00:00.000Z" };
  const html = renderToStaticMarkup(<views.AcceptForm {...formProps} preview={preview} values={f.emptyAcceptForm()} submitLabel="Join the school" />);
  const t = text(html);
  assert.ok(t.includes("Your current password") && t.includes("Your password stays the same") && t.includes("Mavambo Academy"));
  assert.ok(!t.includes("Your name") && !t.includes("Type the password again"));
  assert.ok(/autoComplete="current-password"|autocomplete="current-password"/.test(html));
  assertAccessible(html, "AcceptForm existing");
});

check("reset form: new password twice, with new-password hints", () => {
  const html = renderToStaticMarkup(<views.ResetForm {...formProps} errors={{ confirm: "The two passwords are not the same." }} values={f.emptyResetForm()} submitLabel="Save new password" />);
  const t = text(html);
  assert.ok(t.includes("New password") && t.includes("Type it again") && t.includes("Save new password"));
  assert.equal((html.match(/autoComplete="new-password"|autocomplete="new-password"/g) ?? []).length, 2);
  assert.ok(html.includes('aria-invalid="true"') && t.includes("The two passwords are not the same."));
  assertAccessible(html, "ResetForm");
});

check("a link that no longer works: says what happened and what to do, and offers sign-in", () => {
  for (const code of ["link_used", "link_expired", "link_revoked", "link_not_found", "member_deactivated", "shared_account"] as const) {
    const html = renderToStaticMarkup(<page.LinkEnded code={code} purpose="invitation" />);
    const t = text(html);
    assert.ok(t.length > 40, `${code} says something`);
    assert.ok(html.includes('href="/login"') && t.includes("Go to sign in"), `${code} offers sign-in`);
    assertAccessible(html, `LinkEnded ${code}`);
  }
  assert.ok(text(renderToStaticMarkup(<page.LinkEnded code="link_expired" purpose="invitation" />)).includes("has expired"));
  assert.ok(text(renderToStaticMarkup(<page.LinkEnded code="link_expired" purpose="reset" />)).includes("reset link"));
});

check("link page frame: one heading, the product name, and room for content", () => {
  const html = renderToStaticMarkup(<page.LinkPage title="Join Mavambo Academy" intro="You were invited."><p>content</p></page.LinkPage>);
  assert.equal((html.match(/<h1\b/g) ?? []).length, 1);
  assert.ok(text(html).includes("SchoolPulse") && text(html).includes("Join Mavambo Academy") && text(html).includes("content"));
});

console.log(`\n${passed} staff render checks passed`);
