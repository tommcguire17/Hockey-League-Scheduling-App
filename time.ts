import type { Weekday } from './schema.js';

const DAYS: Weekday[] = [
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
];

/** Parses YYYY-MM-DD as a calendar date with no timezone involvement. */
export function dayNumber(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

export function weekdayOf(iso: string): Weekday {
  // 1970-01-01 (day 0) was a Thursday.
  const idx = (((dayNumber(iso) + 4) % 7) + 7) % 7;
  return DAYS[idx]!;
}

export function daysBetween(a: string, b: string): number {
  return dayNumber(b) - dayNumber(a);
}

/**
 * Identifies the scheduling week a date falls in, given the day the league's
 * week starts on. Returns the ISO date of that week's first day, so two dates
 * in the same week always produce the same key.
 */
export function weekKey(iso: string, startsOn: Weekday): string {
  const start = DAYS.indexOf(startsOn);
  const cur = DAYS.indexOf(weekdayOf(iso));
  const back = (((cur - start) % 7) + 7) % 7;
  const d = new Date((dayNumber(iso) - back) * 86400000);
  return d.toISOString().slice(0, 10);
}

export function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return h * 60 + m;
}

/**
 * Clock times as a parent reads them: "6:30 PM", never "18:30".
 *
 * Ice is stored in 24-hour form because that is the only way it sorts and
 * compares correctly, and every comparison in this app depends on that. But
 * nobody reading a schedule off a phone at the rink should have to subtract
 * twelve, and a 7am skate misread as 7pm is a family that misses a game. So
 * the 24-hour string is for the machine and this is for everyone else: one
 * formatter, used by the console, the public page and the CSV writers alike.
 *
 * Minutes are always shown, including ":00". "7 AM" reads better in a
 * sentence, but these times live in table columns stacked above and below
 * each other, where an even shape is easier to scan than an idiomatic one —
 * and a time written back out to a CSV has to be one a spreadsheet and our
 * own importer will both still read.
 *
 * Anything unparseable comes back untouched rather than as "NaN:NaN PM".
 */
export function fmtTime(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm.trim());
  if (!m) return hhmm;
  const h24 = Number(m[1]);
  const min = Number(m[2]);
  if (h24 > 23 || min > 59) return hhmm;
  const suffix = h24 < 12 ? 'AM' : 'PM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(min).padStart(2, '0')} ${suffix}`;
}

/** "6:30 PM–7:50 PM", given a start and how long the ice is booked for. */
export function fmtTimeRange(hhmm: string, minutes: number): string {
  const start = minutesOf(hhmm);
  if (!Number.isFinite(start) || !Number.isFinite(minutes)) return fmtTime(hhmm);
  const end = (start + minutes) % 1440;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${fmtTime(hhmm)}–${fmtTime(`${pad(Math.floor(end / 60))}:${pad(end % 60)}`)}`;
}

/** A booking, as far as the clock is concerned. */
export interface Booked { start: string; minutes: number }

/**
 * Minutes a team waits between two games on one day: the end of the first to
 * the start of the second. Negative means they overlap.
 */
export function restBetween(a: Booked, b: Booked): number {
  const [first, second] = minutesOf(a.start) <= minutesOf(b.start) ? [a, b] : [b, a];
  return minutesOf(second.start) - (minutesOf(first.start) + first.minutes);
}

export type SameDayVerdict = 'ok' | 'overlaps' | 'tooTight' | 'tooLong';

export const SAME_DAY_REASON: Record<SameDayVerdict, string> = {
  ok: 'a reasonable wait between the two',
  overlaps: 'the two games overlap',
  tooTight: 'no real break between the two',
  tooLong: 'too long a wait between the two',
};

/**
 * Whether two games on the same day are a pair a family could actually do.
 *
 * Not a yes or no about doubles — a judgement about the day. Back to back
 * means coming off the ice and going straight back on; three hours apart
 * means sitting in the rink all afternoon or driving home and driving back.
 * Between those is a lunch, and that is the window worth using.
 */
export function sameDayVerdict(
  a: Booked, b: Booked, rest: { minMinutes: number; maxMinutes: number },
): SameDayVerdict {
  const gap = restBetween(a, b);
  if (gap < 0) return 'overlaps';
  if (gap < rest.minMinutes) return 'tooTight';
  if (gap > rest.maxMinutes) return 'tooLong';
  return 'ok';
}

export type TimeBand = 'morning' | 'midday' | 'evening';

export function bandOf(
  hhmm: string,
  bands: { morningBefore: string; eveningFrom: string },
): TimeBand {
  const t = minutesOf(hhmm);
  if (t < minutesOf(bands.morningBefore)) return 'morning';
  if (t < minutesOf(bands.eveningFrom)) return 'midday';
  return 'evening';
}

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                     'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                    'August', 'September', 'October', 'November', 'December'];
const DAY_LONG: Record<Weekday, string> = {
  sunday: 'Sunday', monday: 'Monday', tuesday: 'Tuesday', wednesday: 'Wednesday',
  thursday: 'Thursday', friday: 'Friday', saturday: 'Saturday',
};

/**
 * Dates as people read them. One implementation, used by the console, the
 * public page and the CSV writers alike — two of these drifting apart is how
 * a schedule ends up saying two different things.
 */
export function fmtDate(iso: string): string {
  const [, m, d] = iso.split('-') as [string, string, string];
  return `${MONTH_SHORT[+m - 1]} ${+d}`;
}
export function fmtDateYear(iso: string): string {
  return `${fmtDate(iso)}, ${iso.slice(0, 4)}`;
}
/** Three-letter weekday, capitalised: "Sat". */
export function fmtDay(iso: string): string {
  return DAY_LONG[weekdayOf(iso)].slice(0, 3);
}
/** "Saturday 5 December 2026", for a page families read. */
export function fmtLongDate(iso: string): string {
  const [y, m, d] = iso.split('-') as [string, string, string];
  return `${DAY_LONG[weekdayOf(iso)]} ${+d} ${MONTH_LONG[+m - 1]} ${y}`;
}
export function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
/** "Friday, Saturday and Sunday" */
export function listDays(days: readonly string[]): string {
  const d = days.map(titleCase);
  if (d.length <= 1) return d[0] ?? '';
  return `${d.slice(0, -1).join(', ')} and ${d.at(-1)}`;
}
