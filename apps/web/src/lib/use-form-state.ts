import { useCallback, useState } from "react";
import { placeFailure, toFailure, type FieldErrors, type Validation } from "./admin-forms.ts";

/**
 * The state every admin form needs: its values, the error under each field, a banner for problems about the whole
 * form, and a busy flag that stops a second tap while the request is running. Editing a field clears its error.
 */
export function useFormState<V extends object>(initial: V | (() => V)) {
  const [values, setValues] = useState<V>(initial);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const change = useCallback((patch: Partial<V>) => {
    setValues((v) => ({ ...v, ...patch }));
    setErrors((e) => {
      const next = { ...e };
      for (const k of Object.keys(patch)) delete next[k];
      return next;
    });
  }, []);

  const reset = useCallback((next: V) => {
    setValues(next);
    setErrors({});
    setBanner(null);
  }, []);

  /**
   * Validates, then runs the request. Returns true if it succeeded. A refusal from the server is shown next to the
   * field it names (if this form has it) or in the banner; the values stay as typed so nothing has to be re-entered.
   */
  const submit = useCallback(async (validation: Validation, run: () => Promise<void>, fields: readonly string[]): Promise<boolean> => {
    if (!validation.ok) {
      setErrors(validation.errors);
      setBanner("That was not saved. Fix the highlighted fields and try again.");
      return false;
    }
    setBusy(true);
    setBanner(null);
    setErrors({});
    try {
      await run();
      return true;
    } catch (e) {
      const placed = placeFailure(toFailure(e), fields);
      setErrors(placed.errors);
      setBanner(placed.banner);
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  return { values, errors, banner, busy, change, reset, submit, setBanner, setErrors, setBusy };
}
