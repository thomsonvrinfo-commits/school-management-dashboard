import { useEffect, useState, useSyncExternalStore } from "react";
import { liveQuery } from "dexie";
import type { Store } from "./store.ts";

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/** Re-runs a Dexie query whenever the data it read changes. */
export function useLive<T>(query: () => Promise<T> | T, deps: readonly unknown[], initial: T): T {
  const [value, setValue] = useState<T>(initial);
  useEffect(() => {
    const sub = liveQuery(query).subscribe({
      next: setValue,
      error: (e) => console.error("Local database read failed", e),
    });
    return () => sub.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return value;
}
