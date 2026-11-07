/**
 * Presentational pieces of the head's activity screen. Controlled components: the screen owns the filters, the pages
 * loaded and the requests; these only show them, with every control labelled and every state in words.
 */
import { Link } from "react-router";
import type { AuditItem } from "@schoolpulse/contracts";
import {
  CATEGORY_LABEL, CATEGORY_OPTIONS, actorLabel, entityLink, timeOf,
  type ActivityDay, type ActivityFilters,
} from "../lib/activity.ts";
import type { FieldErrors } from "../lib/admin-forms.ts";
import { Button, EmptyState, SelectField, StatusPill, TextField } from "./ui.tsx";

export function ActivityFilterBar(props: {
  values: ActivityFilters;
  errors: FieldErrors;
  people: readonly { value: string; label: string }[];
  filtered: boolean;
  onChange: (patch: Partial<ActivityFilters>) => void;
  onClear: () => void;
}) {
  const { values: v, errors: e, onChange } = props;
  return (
    <form role="search" aria-label="Filter activity" noValidate onSubmit={(ev) => ev.preventDefault()} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField label="Kind of change" value={v.category} onChange={(category) => onChange({ category })} placeholder="Everything" options={CATEGORY_OPTIONS} />
        <SelectField label="Done by" value={v.actor} onChange={(actor) => onChange({ actor })} placeholder="Anyone" options={props.people} />
        <TextField label="From" type="date" value={v.from} onChange={(from) => onChange({ from })} error={e.from} />
        <TextField label="To" type="date" value={v.to} onChange={(to) => onChange({ to })} error={e.to} />
      </div>
      {props.filtered ? <Button onClick={props.onClear}>Show everything again</Button> : null}
    </form>
  );
}

export function ActivityEntry({ item, timeZone, youUserId }: { item: AuditItem; timeZone: string; youUserId: string }) {
  const link = entityLink(item.entity);
  return (
    <li className="space-y-1 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 font-semibold">{item.summary}</p>
        <StatusPill tone="quiet">{CATEGORY_LABEL[item.category]}</StatusPill>
      </div>
      <p className="text-sm text-dim">{actorLabel(item.actor, youUserId)} at {timeOf(item.at, timeZone)}</p>
      {item.detail ? <p className="text-sm">{item.detail}</p> : null}
      {link ? <Link to={link.to} className="inline-block min-h-6 text-sm font-semibold underline">{link.label}</Link> : null}
    </li>
  );
}

/** Days newest first, each with a heading and its entries; an empty list explains itself and says whether a filter is why. */
export function ActivityList(props: { days: readonly ActivityDay[]; timeZone: string; youUserId: string; filtered: boolean }) {
  if (props.days.length === 0) {
    return (
      <EmptyState title={props.filtered ? "Nothing matches" : "No activity yet"}>
        {props.filtered ? "Try a different kind of change, person or dates." : "Changes to students, classes, staff and school settings will appear here as they happen."}
      </EmptyState>
    );
  }
  return (
    <div className="space-y-6">
      {props.days.map((d) => (
        <section key={d.day} aria-label={d.heading} className="space-y-1">
          <h2 className="text-sm font-bold uppercase tracking-wide text-dim">{d.heading}</h2>
          <ul className="divide-y divide-white/10">
            {d.items.map((i) => <ActivityEntry key={i.id} item={i} timeZone={props.timeZone} youUserId={props.youUserId} />)}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** "Show older activity", or a line saying there is no more. */
export function OlderActivity(props: { hasMore: boolean; busy: boolean; error: string | null; shown: number; onMore: () => void }) {
  return (
    <div className="space-y-2 pt-2">
      {props.error ? <p role="alert" className="text-sm text-absent">{props.error}</p> : null}
      {props.hasMore ? (
        <Button disabled={props.busy} onClick={props.onMore}>{props.busy ? "Loading…" : "Show older activity"}</Button>
      ) : props.shown > 0 ? (
        <p role="status" className="text-sm text-dim">That is everything: {props.shown} {props.shown === 1 ? "entry" : "entries"}.</p>
      ) : null}
    </div>
  );
}
