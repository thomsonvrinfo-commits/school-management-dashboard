import { useEffect, useMemo, useRef, useState } from "react";
import type { AuditItem } from "@schoolpulse/contracts";
import { ActivityFilterBar, ActivityList, OlderActivity } from "../../components/activity-views.tsx";
import { Button, Loading, Notice, PageHeader } from "../../components/ui.tsx";
import { adminApi } from "../../lib/admin-api.ts";
import { toFailure } from "../../lib/admin-forms.ts";
import { emptyActivityFilters, groupByDay, hasActivityFilters, peopleOptions, toActivityQuery, validateActivityFilters, type ActivityFilters } from "../../lib/activity.ts";
import { authStore } from "../../lib/auth.ts";
import { useStore } from "../../lib/hooks.ts";
import { useRequest } from "../../lib/use-request.ts";

/**
 * Who changed what, and when, in the head's school. Newest first, a page at a time. Read-only: nothing here changes
 * anything. The server decides what each entry says; the details behind an entry are never sent to the phone.
 */
export function ActivityScreen() {
  const auth = useStore(authStore);
  const [draft, setDraft] = useState<ActivityFilters>(emptyActivityFilters());
  // Only a filter that can be asked for (real dates, in order) is applied; a half-typed date waits.
  const [applied, setApplied] = useState<ActivityFilters>(emptyActivityFilters());
  const people = useRequest(() => adminApi.staff(), []);
  // The first page remembers which filters it answers, so a page for the previous filters is never shown (or paged from) as if it were current.
  const first = useRequest(async () => ({ filters: applied, page: await adminApi.activity(toActivityQuery(applied)) }), [applied]);

  // Older pages loaded with "Show older activity". Dropped whenever the filters change or the list is refreshed.
  const [older, setOlder] = useState<{ items: AuditItem[]; nextBefore: string | null } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    setOlder(null);
    setMoreError(null);
    setLoadingMore(false);
  }, [applied]);

  const validation = useMemo(() => validateActivityFilters(draft), [draft]);
  if (auth.status !== "signedIn") return null;
  const { timezone } = auth.me.school;
  const youUserId = auth.me.user.id;

  const change = (patch: Partial<ActivityFilters>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    if (validateActivityFilters(next).ok) setApplied(next);
  };
  const clear = () => {
    setDraft(emptyActivityFilters());
    setApplied(emptyActivityFilters());
  };
  // A fresh copy of the same filters is a new question: the list empties, loads again, and starts from the newest.
  const refresh = () => setApplied((a) => ({ ...a }));

  const filtered = hasActivityFilters(applied);
  const stale = first.state.status === "ready" && first.state.data.filters !== applied;
  const head = first.state.status === "ready" && !stale ? first.state.data.page : null;
  const items = head ? [...head.items, ...(older?.items ?? [])] : [];
  const nextBefore = older ? older.nextBefore : (head?.nextBefore ?? null);

  const showOlder = async () => {
    if (!nextBefore) return;
    const mine = generation.current;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await adminApi.activity(toActivityQuery(applied, nextBefore));
      if (mine !== generation.current) return; // the filters changed while this was loading: these entries are for the old question
      setOlder((o) => ({ items: [...(o?.items ?? []), ...page.items], nextBefore: page.nextBefore }));
    } catch (e) {
      if (mine === generation.current) setMoreError(toFailure(e).message);
    } finally {
      if (mine === generation.current) setLoadingMore(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Activity"
        subtitle="Who changed what, and when. Newest first."
        action={<Button onClick={refresh} disabled={first.state.status === "loading" || stale}>Refresh</Button>}
      />
      <ActivityFilterBar
        values={draft} errors={validation.ok ? {} : validation.errors} people={people.state.status === "ready" ? peopleOptions(people.state.data.members) : []}
        filtered={hasActivityFilters(draft)} onChange={change} onClear={clear}
      />
      {first.state.status === "loading" || stale ? <Loading what="activity" /> : null}
      {first.state.status === "failed" ? <Notice tone="error">{first.state.failure.message}</Notice> : null}
      {head ? (
        <>
          <ActivityList days={groupByDay(items, timezone, new Date())} timeZone={timezone} youUserId={youUserId} filtered={filtered} />
          <OlderActivity hasMore={nextBefore !== null} busy={loadingMore} error={moreError} shown={items.length} onMore={() => void showOlder()} />
        </>
      ) : null}
    </div>
  );
}
