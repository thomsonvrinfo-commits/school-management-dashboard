/**
 * What to tell a person when the app got no usable answer from the server.
 *
 * `api.ts` throws one kind of error (`NetworkFailure`) for three different situations, and the screens used to say
 * "You are offline" for all of them. That sent people to check their phone when the real problem was a server that
 * answered with an error, or a browser that refused to talk to it. These functions keep the three apart. They are pure
 * (no browser, no api.ts) so a test can run them.
 */

/** The part of a NetworkFailure these functions look at. `status` is set when the server did answer, with a 5xx. */
export interface NoAnswer {
  status?: number | undefined;
}

/** What the browser says about its own connection. `undefined` when it cannot say (not in a browser). */
export const browserOnline = (): boolean | undefined => (typeof navigator === "undefined" ? undefined : navigator.onLine);

/**
 * One sentence saying what happened.
 * - the browser says it has no connection: offline;
 * - the server answered with an error (5xx): say so, with the number;
 * - otherwise the request got nothing back although the phone says it is online: the server could not be reached.
 *   (A server address that is wrong, a server that is down, or a server that refuses this site all look like this.)
 */
export function noAnswerLead(err: NoAnswer, online: boolean | undefined): string {
  if (online === false) return "You are offline.";
  if (typeof err.status === "number") return `The server had a problem (${err.status}).`;
  return "Could not reach the server, although your phone says it is online.";
}

/** The sentence above plus what to do next. `offlineAdvice` is what to do when the phone really is offline. */
export function explainNoAnswer(err: NoAnswer, online: boolean | undefined, offlineAdvice: string): string {
  const lead = noAnswerLead(err, online);
  return online === false
    ? `${lead} ${offlineAdvice}`
    : `${lead} Try again in a minute. If it keeps happening, tell the person who looks after SchoolPulse for your school.`;
}
