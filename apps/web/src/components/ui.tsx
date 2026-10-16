/**
 * Shared building blocks for the school-administration screens. They reuse Slice 1's look (dark glass, violet accent,
 * 48px touch targets) and carry the accessibility wiring once: every control has a visible label, errors and hints
 * are tied to their control with aria-describedby, and nothing relies on colour alone.
 */
import { useEffect, useId, useRef } from "react";
import type { ButtonHTMLAttributes, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";

const CONTROL = "mt-1 min-h-12 w-full rounded-xl border bg-white/5 px-3 text-base placeholder:text-dim/60 disabled:opacity-60";
const border = (error: boolean) => (error ? "border-absent" : "border-white/15");

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: ReactNode; action?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-extrabold tracking-tight">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-dim">{subtitle}</p> : null}
      </div>
      {action}
    </header>
  );
}

export function Section({ title, children, action, id }: { title: string; children: ReactNode; action?: ReactNode; id: string }) {
  return (
    <section aria-labelledby={id} className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 id={id} className="text-lg font-bold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

const TONES = {
  error: "border-absent/40 bg-absent/10",
  warn: "border-late/40 bg-late/10",
  info: "border-white/15 bg-white/5",
  success: "border-present/40 bg-present/10",
} as const;

/** Errors interrupt (role=alert); everything else is announced politely (role=status). */
export function Notice({ tone = "info", children }: { tone?: keyof typeof TONES; children: ReactNode }) {
  return (
    <p role={tone === "error" ? "alert" : "status"} className={`rounded-xl border px-4 py-3 text-sm ${TONES[tone]}`}>
      {children}
    </p>
  );
}

export function Loading({ what }: { what: string }) {
  return <p role="status" className="text-dim">Loading {what}…</p>;
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-white/20 px-4 py-8 text-center">
      <p className="font-semibold">{title}</p>
      {children ? <div className="mt-1 text-sm text-dim">{children}</div> : null}
    </div>
  );
}

type Variant = "primary" | "secondary" | "danger";
const VARIANT: Record<Variant, string> = {
  primary: "bg-violet font-bold text-night",
  secondary: "border border-white/20 bg-white/5 font-semibold",
  danger: "bg-absent font-bold text-night",
};
export const buttonClass = (variant: Variant = "secondary") => `inline-flex min-h-12 items-center justify-center rounded-xl px-5 text-base disabled:opacity-60 ${VARIANT[variant]}`;

export function Button({ variant = "secondary", busy, busyLabel, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean; busyLabel?: string }) {
  return (
    <button type="button" {...rest} disabled={rest.disabled || busy} aria-busy={busy || undefined} className={`${buttonClass(variant)} ${rest.className ?? ""}`}>
      {busy && busyLabel ? busyLabel : children}
    </button>
  );
}

const PILL = { good: "border-present/50 text-present", warn: "border-late/50 text-late", bad: "border-absent/50 text-absent", quiet: "border-white/25 text-dim" } as const;
/** The word is the signal; the colour only reinforces it. */
export function StatusPill({ tone = "quiet", children }: { tone?: keyof typeof PILL; children: ReactNode }) {
  return <span className={`inline-block rounded-full border px-2.5 py-0.5 text-xs font-semibold ${PILL[tone]}`}>{children}</span>;
}

// ---------- form controls ----------

interface FieldShell {
  label: string;
  error?: string | undefined;
  hint?: string | undefined;
  required?: boolean | undefined;
}

function Shell({ id, label, error, hint, required, children }: FieldShell & { id: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="text-sm font-semibold">
        {label}
        {required ? <span className="text-dim"> (required)</span> : null}
      </label>
      {hint ? <p id={`${id}-hint`} className="text-xs text-dim">{hint}</p> : null}
      {children}
      {error ? <p id={`${id}-error`} className="mt-1 text-sm text-absent">{error}</p> : null}
    </div>
  );
}
const describedBy = (id: string, error?: string, hint?: string) => [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;

export function TextField(props: FieldShell & {
  value: string; onChange: (v: string) => void; type?: "text" | "email" | "tel" | "date"; maxLength?: number; autoComplete?: string;
  inputMode?: "text" | "email" | "tel" | "search"; list?: string; disabled?: boolean; placeholder?: string;
}) {
  const id = useId();
  const { value, onChange, type = "text", ...shell } = props;
  return (
    <Shell id={id} {...shell}>
      <input
        id={id} type={type} value={value} onChange={(e) => onChange(e.target.value)} maxLength={props.maxLength} autoComplete={props.autoComplete ?? "off"}
        inputMode={props.inputMode} list={props.list} disabled={props.disabled} placeholder={props.placeholder}
        aria-invalid={props.error ? true : undefined} aria-describedby={describedBy(id, props.error, props.hint)}
        className={`${CONTROL} ${border(Boolean(props.error))}`}
      />
    </Shell>
  );
}

export function SelectField(props: FieldShell & {
  value: string; onChange: (v: string) => void; options: readonly { value: string; label: string }[]; placeholder?: string; disabled?: boolean;
}) {
  const id = useId();
  const { value, onChange, options, placeholder, ...shell } = props;
  return (
    <Shell id={id} {...shell}>
      <select
        id={id} value={value} onChange={(e) => onChange(e.target.value)} disabled={props.disabled}
        aria-invalid={props.error ? true : undefined} aria-describedby={describedBy(id, props.error, props.hint)}
        className={`${CONTROL} ${border(Boolean(props.error))}`}
      >
        {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </Shell>
  );
}

export function CheckField({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  const id = useId();
  return (
    <div className="flex items-start gap-3">
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} aria-describedby={hint ? `${id}-hint` : undefined} className="mt-1 size-6 accent-violet" />
      <label htmlFor={id} className="min-h-6 text-sm font-semibold">
        {label}
        {hint ? <span id={`${id}-hint`} className="block font-normal text-dim">{hint}</span> : null}
      </label>
    </div>
  );
}

/** Wraps a form: Enter submits, the browser's own validation is off (the shared schemas explain problems better), the banner reads out. */
export function FormFrame({ onSubmit, banner, children, label }: { onSubmit: () => void; banner?: string | null | undefined; children: ReactNode; label: string }) {
  return (
    <form aria-label={label} noValidate onSubmit={(e) => { e.preventDefault(); onSubmit(); }} className="space-y-4">
      {banner ? <Notice tone="error">{banner}</Notice> : null}
      {children}
    </form>
  );
}

export function FormActions({ busy, submitLabel, busyLabel, onCancel }: { busy: boolean; submitLabel: string; busyLabel?: string; onCancel?: (() => void) | undefined }) {
  return (
    <div className="flex flex-wrap gap-3">
      <button type="submit" disabled={busy} aria-busy={busy || undefined} className={buttonClass("primary")}>
        {busy ? (busyLabel ?? "Saving…") : submitLabel}
      </button>
      {onCancel ? <button type="button" onClick={onCancel} disabled={busy} className={buttonClass("secondary")}>Cancel</button> : null}
    </div>
  );
}

export function Pager({ from, to, total, hasPrev, hasNext, onPrev, onNext, noun = "results" }: {
  from: number; to: number; total: number; hasPrev: boolean; hasNext: boolean; onPrev: () => void; onNext: () => void; noun?: string;
}) {
  return (
    <nav aria-label="Pages" className="flex items-center justify-between gap-3 pt-2">
      <button type="button" onClick={onPrev} disabled={!hasPrev} className={buttonClass("secondary")}>Previous</button>
      <p role="status" className="text-center text-sm text-dim">{total === 0 ? `No ${noun}` : `Showing ${from} to ${to} of ${total}`}</p>
      <button type="button" onClick={onNext} disabled={!hasNext} className={buttonClass("secondary")}>Next</button>
    </nav>
  );
}

/**
 * Asks before anything that cannot be quietly undone. The safe answer (Cancel) has focus, Escape cancels, and Tab
 * stays inside the dialog. While the request runs the buttons are disabled so it cannot be sent twice.
 */
export function ConfirmDialog({ title, children, confirmLabel, busyLabel, danger = false, busy = false, error, onConfirm, onCancel }: {
  title: string; children: ReactNode; confirmLabel: string; busyLabel?: string; danger?: boolean; busy?: boolean; error?: string | null | undefined;
  onConfirm: () => void; onCancel: () => void;
}) {
  const titleId = useId();
  const bodyId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    cancel.current?.focus();
    return () => before?.focus?.();
  }, []);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && !busy) {
      e.stopPropagation();
      onCancel();
      return;
    }
    if (e.key !== "Tab") return;
    const items = [...(panel.current?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? [])];
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/60 p-4 sm:items-center" onKeyDown={onKeyDown}>
      <div ref={panel} role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={bodyId} className="w-full max-w-md space-y-4 rounded-2xl border border-white/15 bg-deep p-5 shadow-xl">
        <h2 id={titleId} className="text-lg font-bold">{title}</h2>
        <div id={bodyId} className="space-y-2 text-sm text-dim">{children}</div>
        {error ? <Notice tone="error">{error}</Notice> : null}
        <div className="flex flex-wrap justify-end gap-3">
          <button ref={cancel} type="button" onClick={onCancel} disabled={busy} className={buttonClass("secondary")}>Cancel</button>
          <button type="button" onClick={onConfirm} disabled={busy} aria-busy={busy || undefined} className={buttonClass(danger ? "danger" : "primary")}>
            {busy ? (busyLabel ?? "Working…") : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
