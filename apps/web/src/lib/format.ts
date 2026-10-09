export const formatRate = (rate: number | null): string => (rate === null ? "No registers yet" : `${rate}%`);

/** "up 2.1 points", "down 14.2 points", "no change". The words carry the meaning, not the colour. */
export function describeChange(points: number | null): string | null {
  if (points === null) return null;
  if (points === 0) return "no change";
  const n = Math.abs(points);
  return `${points > 0 ? "up" : "down"} ${n} ${n === 1 ? "point" : "points"}`;
}

export function greeting(now: Date): string {
  const h = now.getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

export function longDate(isoDate: string): string {
  return new Date(`${isoDate}T12:00:00`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
}

export function shortDate(isoDate: string): string {
  return new Date(`${isoDate}T12:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
