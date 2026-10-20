/**
 * Presentational pieces of the staff screens. Like the Slice 2 forms they are controlled components: the screen owns the
 * values, the request and the errors; these only show them, with every control labelled and every state in words.
 */
import { useId } from "react";
import type { InvitationItem, InvitationPreview, StaffMember } from "@schoolpulse/contracts";
import {
  ROLE_LABEL, expiryLabel, inviteeLabel, memberActions, memberStatus, timeLeft, whatsAppUrl,
  type AcceptFormValues, type InviteFormValues, type ResetFormValues,
} from "../lib/staff-forms.ts";
import type { FieldErrors } from "../lib/admin-forms.ts";
import { Button, FormActions, FormFrame, Notice, PasswordField, StatusPill, TextField } from "./ui.tsx";

interface FormProps<V> {
  values: V;
  errors: FieldErrors;
  banner?: string | null | undefined;
  busy: boolean;
  onChange: (patch: Partial<V>) => void;
  onSubmit: () => void;
  onCancel?: (() => void) | undefined;
  submitLabel: string;
}

// ---------- the head's staff list ----------

export function InviteForm(props: FormProps<InviteFormValues>) {
  const { values: v, errors: e, onChange } = props;
  return (
    <FormFrame label="Invite a teacher" onSubmit={props.onSubmit} banner={props.banner}>
      <TextField label="Email address" required type="email" inputMode="email" value={v.email} onChange={(email) => onChange({ email })} error={e.email}
        maxLength={254} autoComplete="off" hint="This becomes their sign-in name. We do not send anything: you will get a link to pass on yourself." />
      <TextField label="Name" value={v.name} onChange={(name) => onChange({ name })} error={e.name} maxLength={200}
        hint="Optional. Helps you recognise the invitation; they confirm their own name." />
      <FormActions busy={props.busy} submitLabel={props.submitLabel} busyLabel="Making the link…" onCancel={props.onCancel} />
    </FormFrame>
  );
}

export interface MemberRowProps {
  member: StaffMember;
  youUserId: string;
  busy?: boolean;
  onSwitchOff: () => void;
  onSwitchOn: () => void;
  onResetLink: () => void;
}

export function MemberRow({ member, youUserId, busy, onSwitchOff, onSwitchOn, onResetLink }: MemberRowProps) {
  const status = memberStatus(member);
  const actions = memberActions(member, youUserId);
  const isYou = member.userId === youUserId;
  return (
    <li className="space-y-3 py-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-semibold">
            {member.name}
            {isYou ? <span className="font-normal text-dim"> (you)</span> : null}
          </p>
          <p className="truncate text-sm text-dim">{member.email}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill tone="quiet">{ROLE_LABEL[member.role]}</StatusPill>
          <StatusPill tone={status.tone}>{status.label}</StatusPill>
        </div>
      </div>
      {actions.switchOff || actions.switchOn || actions.resetLink ? (
        <div className="flex flex-wrap gap-2">
          {actions.resetLink ? <Button disabled={busy} onClick={onResetLink} aria-label={`Make a password reset link for ${member.name}`}>Reset password</Button> : null}
          {actions.switchOff ? <Button disabled={busy} onClick={onSwitchOff} aria-label={`Switch access off for ${member.name}`}>Switch access off</Button> : null}
          {actions.switchOn ? <Button variant="primary" disabled={busy} onClick={onSwitchOn} aria-label={`Switch access back on for ${member.name}`}>Switch access on</Button> : null}
        </div>
      ) : member.role === "head" && !isYou ? (
        <p className="text-xs text-dim">Head teacher accounts are managed by whoever runs SchoolPulse for your school.</p>
      ) : null}
    </li>
  );
}

export function InvitationRow({ invitation, now, busy, onNewLink, onWithdraw }: { invitation: InvitationItem; now: Date; busy?: boolean; onNewLink: () => void; onWithdraw: () => void }) {
  const label = inviteeLabel(invitation);
  return (
    <li className="space-y-3 py-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 truncate font-semibold">{label}</p>
        <StatusPill tone="warn">Waiting</StatusPill>
      </div>
      <p className="text-sm text-dim">Link works once. {timeLeft(invitation.expiresAt, now)} (until {expiryLabel(invitation.expiresAt)}).</p>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={onNewLink} aria-label={`Make a new link for ${label}`}>Make a new link</Button>
        <Button disabled={busy} onClick={onWithdraw} aria-label={`Withdraw the invitation for ${label}`}>Withdraw</Button>
      </div>
    </li>
  );
}

/**
 * Shows a link the head has just made, once, with ways to hand it over. The secret is not stored anywhere, so this is
 * the only time it can be copied: the panel says so.
 */
export function LinkPanel(props: {
  heading: string;
  link: string;
  message: string;
  expiresAt: string;
  copied: boolean;
  canShare: boolean;
  onCopy: () => void;
  onShare: () => void;
  onDone: () => void;
}) {
  const id = useId();
  return (
    <section aria-labelledby={`${id}-h`} className="space-y-4 rounded-2xl border border-violet/40 bg-violet/10 p-4">
      <h2 id={`${id}-h`} className="text-lg font-bold">{props.heading}</h2>
      <Notice tone="warn">
        This link is shown only now. It works once and stops on {expiryLabel(props.expiresAt)}. Anyone who has it can use it, so send it only to this person.
      </Notice>
      <div>
        <label htmlFor={`${id}-link`} className="text-sm font-semibold">The link</label>
        <input id={`${id}-link`} readOnly value={props.link} onFocus={(e) => e.currentTarget.select()}
          className="mt-1 min-h-12 w-full rounded-xl border border-white/15 bg-white/5 px-3 text-sm" />
      </div>
      <div className="flex flex-wrap gap-3">
        <Button variant="primary" onClick={props.onCopy}>{props.copied ? "Copied" : "Copy link"}</Button>
        <a href={whatsAppUrl(props.message)} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-12 items-center justify-center rounded-xl border border-white/20 bg-white/5 px-5 text-base font-semibold">
          Send on WhatsApp
        </a>
        {props.canShare ? <Button onClick={props.onShare}>Share…</Button> : null}
        <Button onClick={props.onDone}>Done</Button>
      </div>
      <p role="status" className="text-sm text-dim">{props.copied ? "The link is copied. Paste it into a message to the person." : ""}</p>
    </section>
  );
}

// ---------- the public screens ----------

export function AcceptForm(props: FormProps<AcceptFormValues> & { preview: InvitationPreview }) {
  const { values: v, errors: e, onChange, preview } = props;
  return (
    <FormFrame label="Set up your account" onSubmit={props.onSubmit} banner={props.banner}>
      {preview.accountExists ? (
        <>
          <Notice tone="info">You already have a SchoolPulse account with {preview.email}. Enter its password to join {preview.schoolName}. Your password stays the same.</Notice>
          <PasswordField label="Your current password" required value={v.password} onChange={(password) => onChange({ password })} error={e.password} autoComplete="current-password" />
        </>
      ) : (
        <>
          <TextField label="Your name" required value={v.name} onChange={(name) => onChange({ name })} error={e.name} maxLength={200} autoComplete="name" />
          <PasswordField label="Choose a password" required value={v.password} onChange={(password) => onChange({ password })} error={e.password} autoComplete="new-password"
            hint="At least 10 characters. A few ordinary words together work well, for example: violet harbour lantern." />
          <PasswordField label="Type the password again" required value={v.confirm} onChange={(confirm) => onChange({ confirm })} error={e.confirm} autoComplete="new-password" />
        </>
      )}
      <FormActions busy={props.busy} submitLabel={props.submitLabel} busyLabel="Setting up…" />
    </FormFrame>
  );
}

export function ResetForm(props: FormProps<ResetFormValues>) {
  const { values: v, errors: e, onChange } = props;
  return (
    <FormFrame label="Choose a new password" onSubmit={props.onSubmit} banner={props.banner}>
      <PasswordField label="New password" required value={v.password} onChange={(password) => onChange({ password })} error={e.password} autoComplete="new-password"
        hint="At least 10 characters. A few ordinary words together work well." />
      <PasswordField label="Type it again" required value={v.confirm} onChange={(confirm) => onChange({ confirm })} error={e.confirm} autoComplete="new-password" />
      <FormActions busy={props.busy} submitLabel={props.submitLabel} busyLabel="Saving…" />
    </FormFrame>
  );
}
