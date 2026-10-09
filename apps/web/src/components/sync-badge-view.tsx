import type { SyncIndicator, SyncState } from "@schoolpulse/sync";

const TONE: Record<SyncIndicator, { dot: string; text: string }> = {
  synced: { dot: "bg-present text-present", text: "text-mist" },
  syncing: { dot: "bg-violet text-violet pulse-dot", text: "text-mist" },
  offline: { dot: "bg-late text-late", text: "text-mist" },
  problem: { dot: "bg-absent text-absent", text: "text-mist" },
};

/** What the teacher needs to trust the app: is my work safe, and has it reached the school? */
export function SyncBadgeView({ state }: { state: SyncState }) {
  const tone = TONE[state.indicator];
  return (
    <span className={`inline-flex min-h-9 items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 text-sm font-medium ${tone.text}`}>
      <span aria-hidden="true" className={`size-2.5 rounded-full ${tone.dot}`} />
      {state.label}
    </span>
  );
}
