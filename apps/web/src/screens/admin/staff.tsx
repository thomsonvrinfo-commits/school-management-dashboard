import { useState } from "react";
import type { InvitationItem, StaffMember } from "@schoolpulse/contracts";
import { InvitationRow, InviteForm, LinkPanel, MemberRow } from "../../components/staff-views.tsx";
import { Button, ConfirmDialog, EmptyState, Loading, Notice, PageHeader, Section } from "../../components/ui.tsx";
import { adminApi } from "../../lib/admin-api.ts";
import { toFailure } from "../../lib/admin-forms.ts";
import { authStore } from "../../lib/auth.ts";
import { useStore } from "../../lib/hooks.ts";
import { linkUrl } from "../../lib/link-token.ts";
import {
  INVITE_FIELDS, emptyInviteForm, invitationMessage, resetMessage, toInviteRequest, validateInvite,
} from "../../lib/staff-forms.ts";
import { useFormState } from "../../lib/use-form-state.ts";
import { useRequest } from "../../lib/use-request.ts";

type Confirm =
  | { kind: "switch-off"; member: StaffMember }
  | { kind: "reset"; member: StaffMember }
  | { kind: "withdraw"; invitation: InvitationItem }
  | { kind: "renew"; invitation: InvitationItem };

interface Issued {
  heading: string;
  link: string;
  message: string;
  expiresAt: string;
}

/**
 * The head's staff screen: who works here, inviting teachers, switching access off and on, and handing over password
 * reset links. Nothing is emailed: every link is shown once for the head to pass on (WhatsApp, a text, in person).
 */
export function StaffScreen() {
  const auth = useStore(authStore);
  const { state, reload } = useRequest(() => adminApi.staff(), []);
  const [inviting, setInviting] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [copied, setCopied] = useState(false);
  const [rowBusy, setRowBusy] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const invite = useFormState(emptyInviteForm);

  if (auth.status !== "signedIn") return null;
  if (state.status === "loading") return <Loading what="your staff" />;
  if (state.status === "failed") return <Notice tone="error">{state.failure.message}</Notice>;
  const { members, invitations } = state.data;
  const school = auth.me.school.name;
  const now = new Date();

  const show = (heading: string, token: string, expiresAt: string, kind: "accept" | "reset", messageFor: (link: string) => string) => {
    const link = linkUrl(window.location.origin, kind, token);
    setCopied(false);
    setIssued({ heading, link, message: messageFor(link), expiresAt });
  };

  const showInvitation = (r: { token: string; invitation: InvitationItem }) =>
    show(`Link for ${r.invitation.name ?? r.invitation.email}`, r.token, r.invitation.expiresAt, "accept", (link) => invitationMessage(school, link, r.invitation.expiresAt));

  const submitInvite = async () => {
    const ok = await invite.submit(validateInvite(invite.values), async () => {
      showInvitation(await adminApi.inviteStaff(toInviteRequest(invite.values)));
    }, INVITE_FIELDS);
    if (ok) {
      invite.reset(emptyInviteForm());
      setInviting(false);
      setFlash(null);
      reload();
    }
  };

  const switchOn = async (m: StaffMember) => {
    setRowBusy(true);
    try {
      await adminApi.reactivateStaff(m.membershipId);
      setFlash(`${m.name}'s access is back on. They sign in with their usual password.`);
      reload();
    } catch (e) {
      setFlash(null);
      setBanner(toFailure(e).message);
    } finally {
      setRowBusy(false);
    }
  };

  const runConfirm = async () => {
    if (!confirm) return;
    setConfirmBusy(true);
    setConfirmError(null);
    try {
      if (confirm.kind === "switch-off") {
        await adminApi.deactivateStaff(confirm.member.membershipId);
        setFlash(`${confirm.member.name} is signed out everywhere and cannot sign in. You can switch access back on at any time.`);
      } else if (confirm.kind === "reset") {
        const r = await adminApi.staffResetLink(confirm.member.membershipId);
        show(`Reset link for ${r.staffName}`, r.token, r.expiresAt, "reset", (link) => resetMessage(r.staffName, school, link, r.expiresAt));
        setFlash(null);
      } else if (confirm.kind === "renew") {
        const r = await adminApi.inviteStaff({ email: confirm.invitation.email, ...(confirm.invitation.name ? { name: confirm.invitation.name } : {}) });
        showInvitation(r);
        setFlash(null);
      } else {
        await adminApi.revokeInvitation(confirm.invitation.id);
        setFlash("The invitation was withdrawn. Its link no longer works.");
      }
      setConfirm(null);
      setBanner(null);
      reload();
    } catch (e) {
      setConfirmError(toFailure(e).message);
    } finally {
      setConfirmBusy(false);
    }
  };

  const copy = async () => {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.link);
      setCopied(true);
    } catch {
      setCopied(false);
      setBanner("Your browser did not allow copying. Press and hold the link in the box to copy it, or use WhatsApp.");
    }
  };
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";
  const share = async () => {
    if (!issued) return;
    try {
      await navigator.share({ text: issued.message });
    } catch {
      /* the person closed the share sheet: nothing to do */
    }
  };

  return (
    <div className="space-y-8">
      <PageHeader
        title="Staff"
        subtitle={`People who can sign in to ${school}.`}
        action={inviting ? null : <Button variant="primary" onClick={() => { setInviting(true); setIssued(null); setFlash(null); }}>Invite a teacher</Button>}
      />

      {flash ? <Notice tone="success">{flash}</Notice> : null}
      {banner ? <Notice tone="error">{banner}</Notice> : null}

      {issued ? (
        <LinkPanel
          heading={issued.heading} link={issued.link} message={issued.message} expiresAt={issued.expiresAt} copied={copied} canShare={canShare}
          onCopy={copy} onShare={share} onDone={() => { setIssued(null); setCopied(false); setBanner(null); }}
        />
      ) : null}

      {inviting ? (
        <InviteForm
          values={invite.values} errors={invite.errors} banner={invite.banner} busy={invite.busy} onChange={invite.change} onSubmit={submitInvite}
          onCancel={() => { setInviting(false); invite.reset(emptyInviteForm()); }} submitLabel="Make invitation link"
        />
      ) : null}

      <Section id="staff-people" title={`People (${members.length})`}>
        <ul className="divide-y divide-white/10">
          {members.map((m) => (
            <MemberRow
              key={m.membershipId} member={m} youUserId={auth.me.user.id} busy={rowBusy}
              onSwitchOff={() => { setConfirmError(null); setConfirm({ kind: "switch-off", member: m }); }}
              onSwitchOn={() => void switchOn(m)}
              onResetLink={() => { setConfirmError(null); setConfirm({ kind: "reset", member: m }); }}
            />
          ))}
        </ul>
      </Section>

      <Section id="staff-invitations" title={`Waiting to join (${invitations.length})`}>
        {invitations.length === 0 ? (
          <EmptyState title="No invitations waiting">Invite a teacher and pass them the link. Once they set a password they appear above.</EmptyState>
        ) : (
          <ul className="divide-y divide-white/10">
            {invitations.map((i) => (
              <InvitationRow
                key={i.id} invitation={i} now={now}
                onNewLink={() => { setConfirmError(null); setConfirm({ kind: "renew", invitation: i }); }}
                onWithdraw={() => { setConfirmError(null); setConfirm({ kind: "withdraw", invitation: i }); }}
              />
            ))}
          </ul>
        )}
      </Section>

      {confirm?.kind === "switch-off" ? (
        <ConfirmDialog title={`Switch access off for ${confirm.member.name}?`} confirmLabel="Switch access off" busyLabel="Switching off…" danger busy={confirmBusy} error={confirmError}
          onConfirm={runConfirm} onCancel={() => setConfirm(null)}>
          <p>They will be signed out on every phone straight away and cannot sign in until you switch access back on.</p>
          <p>Their name stays on past registers and their classes stay as they are.</p>
        </ConfirmDialog>
      ) : null}
      {confirm?.kind === "reset" ? (
        <ConfirmDialog title={`Make a reset link for ${confirm.member.name}?`} confirmLabel="Make the link" busyLabel="Making the link…" busy={confirmBusy} error={confirmError}
          onConfirm={runConfirm} onCancel={() => setConfirm(null)}>
          <p>You will get a one-day link to pass on. They open it and choose a new password.</p>
          <p>Their current password keeps working until they use the link. When they do, they are signed out everywhere. A link made earlier stops working.</p>
        </ConfirmDialog>
      ) : null}
      {confirm?.kind === "renew" ? (
        <ConfirmDialog title="Make a new link?" confirmLabel="Make a new link" busyLabel="Making the link…" busy={confirmBusy} error={confirmError}
          onConfirm={runConfirm} onCancel={() => setConfirm(null)}>
          <p>The link sent before stops working. Use this when the first one was lost or never arrived.</p>
        </ConfirmDialog>
      ) : null}
      {confirm?.kind === "withdraw" ? (
        <ConfirmDialog title="Withdraw this invitation?" confirmLabel="Withdraw" busyLabel="Withdrawing…" danger busy={confirmBusy} error={confirmError}
          onConfirm={runConfirm} onCancel={() => setConfirm(null)}>
          <p>The link stops working. You can invite them again later.</p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
