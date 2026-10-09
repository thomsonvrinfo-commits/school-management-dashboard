import { useCallback, useEffect, useState } from "react";
import type { AttendanceSummaryResponse } from "@schoolpulse/contracts";
import { SummaryView } from "../components/summary.tsx";
import { ApiFailure, NetworkFailure, api } from "../lib/api.ts";
import { getMeta, setMeta } from "../lib/db.ts";
import { clock } from "../lib/format.ts";

interface Cached {
  fetchedAt: string;
  data: AttendanceSummaryResponse;
}

/** The head's first screen. Needs a connection; shows the last figures it received when offline. */
export function Overview() {
  const [data, setData] = useState<AttendanceSummaryResponse | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const fresh = await api.attendanceSummary();
      const at = new Date().toISOString();
      setData(fresh);
      setFetchedAt(at);
      setNotice(null);
      await setMeta("lastSummary", { fetchedAt: at, data: fresh } satisfies Cached);
    } catch (e) {
      const cached = await getMeta<Cached>("lastSummary");
      if (cached) {
        setData(cached.data);
        setFetchedAt(cached.fetchedAt);
      }
      if (e instanceof NetworkFailure) {
        setNotice(cached ? `You are offline. Showing the figures from ${clock(cached.fetchedAt)}.` : "You are offline and there are no saved figures yet. Connect to the internet to see school attendance.");
      } else if (e instanceof ApiFailure) {
        setNotice(e.message);
      } else {
        throw e;
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">Attendance this week</h1>
          {fetchedAt ? <p className="text-sm text-dim">Updated at {clock(fetchedAt)}</p> : null}
        </div>
        <button type="button" onClick={() => void load()} disabled={loading} className="min-h-11 rounded-xl border border-white/20 bg-white/5 px-4 text-sm font-semibold disabled:opacity-60">
          {loading ? "Updating…" : "Update"}
        </button>
      </header>

      {notice ? <p role="status" className="rounded-xl border border-late/40 bg-late/10 px-4 py-3 text-sm">{notice}</p> : null}
      {data ? <SummaryView data={data} /> : loading ? <p className="text-dim">Loading attendance…</p> : null}
    </div>
  );
}
