import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import type { InvitationPreview } from "@schoolpulse/contracts";
import { AcceptForm } from "../components/staff-views.tsx";
import { homeFor } from "../components/shell.tsx";
import { Button, Loading, Notice } from "../components/ui.tsx";
import { NetworkFailure, ApiFailure, api } from "../lib/api.ts";
import { toFailure } from "../lib/admin-forms.ts";
import { acceptInvitation, authStore } from "../lib/auth.ts";
import { useStore } from "../lib/hooks.ts";
import { forgetLinkToken } from "../lib/link-token.ts";
import { ACCEPT_FIELDS, LINK_ENDED, emptyAcceptForm, toAcceptRequest, validateAccept } from "../lib/staff-forms.ts";
import { useFormState } from "../lib/use-form-state.ts";
import { LinkEnded, LinkPage, sessionStorageOrNull, useLinkToken } from "./link-page.tsx";

type Load = { status: "loading" } | { status: "ready"; preview: InvitationPreview } | { status: "ended"; code: string | undefined } | { status: "offline" };

/** Where an invitation link lands: shows who is inviting, lets the person set up (or join with) their account, and signs them in. */
export function AcceptInvitation() {
  const token = useLinkToken("accept");
  const navigate = useNavigate();
  const auth = useStore(authStore);
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const form = useFormState(() => emptyAcceptForm(null));

  useEffect(() => {
    if (!token) return;
    let current = true;
    setLoad({ status: "loading" });
    api.previewInvitation(token).then(
      (preview) => {
        if (!current) return;
        form.reset(emptyAcceptForm(preview.suggestedName));
        setLoad({ status: "ready", preview });
      },
      (e: unknown) => {
        if (!current) return;
        if (e instanceof NetworkFailure) setLoad({ status: "offline" });
        else setLoad({ status: "ended", code: e instanceof ApiFailure ? e.code : undefined });
      },
    );
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, attempt]);

  if (!token) {
    return (
      <LinkPage title="Join your school">
        <LinkEnded code="link_not_found" purpose="invitation" />
      </LinkPage>
    );
  }
  if (load.status === "loading") return <LinkPage title="Join your school"><Loading what="your invitation" /></LinkPage>;
  if (load.status === "offline") {
    return (
      <LinkPage title="Join your school">
        <Notice tone="error">You are offline. Connect to the internet to open your invitation.</Notice>
        <Button variant="primary" onClick={() => setAttempt((n) => n + 1)}>Try again</Button>
      </LinkPage>
    );
  }
  if (load.status === "ended") return <LinkPage title="Join your school"><LinkEnded code={load.code} purpose="invitation" /></LinkPage>;

  const { preview } = load;
  const signedInAs = auth.status === "signedIn" ? auth.me.user : null;

  const submit = async () => {
    const validation = validateAccept(form.values, preview);
    await form.submit(validation, async () => {
      try {
        await acceptInvitation(toAcceptRequest(form.values, preview, token));
      } catch (e) {
        const f = toFailure(e);
        if (f.code && LINK_ENDED.has(f.code)) setLoad({ status: "ended", code: f.code });
        throw e;
      }
      forgetLinkToken("accept", sessionStorageOrNull());
      const next = authStore.get();
      navigate(next.status === "signedIn" ? homeFor(next.me.role) : "/", { replace: true });
    }, ACCEPT_FIELDS);
  };

  return (
    <LinkPage title={`Join ${preview.schoolName}`} intro={`You were invited as ${preview.role === "head" ? "the school head" : "a teacher"} with ${preview.email}.`}>
      {signedInAs ? <Notice tone="warn">This phone is signed in as {signedInAs.name}. Continuing signs them out here.</Notice> : null}
      <AcceptForm
        preview={preview} values={form.values} errors={form.errors} banner={form.banner} busy={form.busy} onChange={form.change} onSubmit={() => void submit()}
        submitLabel={preview.accountExists ? "Join the school" : "Create my account"}
      />
    </LinkPage>
  );
}
