import { useState } from "react";
import { Link } from "react-router";
import { ResetForm } from "../components/staff-views.tsx";
import { Notice, buttonClass } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { toFailure } from "../lib/admin-forms.ts";
import { forgetLinkToken } from "../lib/link-token.ts";
import { LINK_ENDED, RESET_FIELDS, emptyResetForm, validateReset } from "../lib/staff-forms.ts";
import { useFormState } from "../lib/use-form-state.ts";
import { LinkEnded, LinkPage, sessionStorageOrNull, useLinkToken } from "./link-page.tsx";

/** Where a password-reset link lands: the person chooses a new password, every old sign-in ends, and they sign in again. */
export function ResetPassword() {
  const token = useLinkToken("reset");
  const form = useFormState(emptyResetForm);
  const [ended, setEnded] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (!token) return <LinkPage title="Choose a new password"><LinkEnded code="link_not_found" purpose="reset" /></LinkPage>;
  if (ended) return <LinkPage title="Choose a new password"><LinkEnded code={ended} purpose="reset" /></LinkPage>;
  if (done) {
    return (
      <LinkPage title="Password changed">
        <Notice tone="success">Your new password is saved. You were signed out everywhere, so sign in again with it.</Notice>
        <Link to="/login" className={buttonClass("primary")}>Go to sign in</Link>
      </LinkPage>
    );
  }

  const submit = () =>
    form.submit(validateReset(form.values), async () => {
      try {
        await api.completePasswordReset({ token, password: form.values.password });
      } catch (e) {
        const f = toFailure(e);
        if (f.code && LINK_ENDED.has(f.code)) setEnded(f.code);
        throw e;
      }
      forgetLinkToken("reset", sessionStorageOrNull());
      setDone(true);
    }, RESET_FIELDS);

  return (
    <LinkPage title="Choose a new password" intro="Your head teacher sent you this link.">
      <ResetForm values={form.values} errors={form.errors} banner={form.banner} busy={form.busy} onChange={form.change} onSubmit={() => void submit()} submitLabel="Save new password" />
    </LinkPage>
  );
}
