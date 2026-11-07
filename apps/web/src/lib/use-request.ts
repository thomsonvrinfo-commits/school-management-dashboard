import { useCallback, useEffect, useState } from "react";
import { toFailure, type Failure } from "./admin-forms.ts";

export type RequestState<T> = { status: "loading" } | { status: "ready"; data: T } | { status: "failed"; failure: Failure };

/**
 * Loads data from the API when the screen opens or `deps` change, and again when `reload()` is called. While a reload
 * is under way the previous data stays on screen (no flash of an empty page); a failed reload replaces it with the error.
 */
export function useRequest<T>(load: () => Promise<T>, deps: readonly unknown[]): { state: RequestState<T>; reload: () => void } {
  const [state, setState] = useState<RequestState<T>>({ status: "loading" });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let current = true;
    setState((s) => (s.status === "ready" ? s : { status: "loading" }));
    load().then(
      (data) => {
        if (current) setState({ status: "ready", data });
      },
      (e: unknown) => {
        if (current) setState({ status: "failed", failure: toFailure(e) });
      },
    );
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { state, reload };
}
