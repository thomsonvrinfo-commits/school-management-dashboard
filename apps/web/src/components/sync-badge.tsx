import { Link } from "react-router";
import { syncState } from "@schoolpulse/sync";
import { SyncBadgeView } from "./sync-badge-view.tsx";
import { engineStatus, loadQueue } from "../lib/sync-engine.ts";
import { useLive, useStore } from "../lib/hooks.ts";

export function SyncBadge() {
  const status = useStore(engineStatus);
  const queue = useLive(loadQueue, [], []);
  const state = syncState({ online: status.online && status.reachable, queue, syncing: status.syncing });
  return (
    <Link to="/sync" aria-label={`Sync status: ${state.label}. Open details.`} role="status" aria-live="polite">
      <SyncBadgeView state={state} />
    </Link>
  );
}
