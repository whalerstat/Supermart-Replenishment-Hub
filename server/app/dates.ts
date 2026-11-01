// server/app/dates.ts — calendar helpers on ISO date strings (no time zones: business dates only).

const DAY = 86_400_000;

export function toDay(iso: string): number {
  return Math.round(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / DAY);
}

export function fromDay(n: number): string {
  return new Date(n * DAY).toISOString().slice(0, 10);
}

export function addDays(iso: string, n: number): string {
  return fromDay(toDay(iso) + n);
}

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export function isoDow(iso: string): number {
  const d = new Date(toDay(iso) * DAY).getUTCDay();
  return d === 0 ? 7 : d;
}

const WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Tue 22 Dec" */
export function label(iso: string): string {
  return `${WD[isoDow(iso) - 1]} ${+iso.slice(8, 10)} ${MON[+iso.slice(5, 7) - 1]}`;
}

/** "22 Dec" */
export function short(iso: string): string {
  return `${+iso.slice(8, 10)} ${MON[+iso.slice(5, 7) - 1]}`;
}

export function range(fromIso: string, toIsoInclusive: string): string[] {
  const out: string[] = [];
  for (let n = toDay(fromIso); n <= toDay(toIsoInclusive); n++) out.push(fromDay(n));
  return out;
}
