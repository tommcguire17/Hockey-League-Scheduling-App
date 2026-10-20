/** Shared coercions. Every one of these exists because a real file broke on it. */

/** "Rocky Rink" and "Rocky" are the same sheet of ice. */
export function normalizeRink(raw: string): string {
  const s = raw.trim().replace(/\s+/g, ' ');
  return s.replace(/\s+(rink|arena|sheet)$/i, '').trim();
}

/** Accepts 2026-12-05, 12/5/2026, 12/5/26, and Excel/Sheets serial numbers. */
export function normalizeDate(raw: string): string | null {
  const s = String(raw).trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return iso(+m[1]!, +m[2]!, +m[3]!);
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/.exec(s);
  if (m) {
    let y = +m[3]!;
    if (y < 100) y += y < 70 ? 2000 : 1900;
    return iso(y, +m[1]!, +m[2]!);
  }
  if (/^\d+(\.\d+)?$/.test(s)) {
    // Excel serial, 1900 date system with the historical leap-year bug.
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(+s) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}
const iso = (y: number, m: number, d: number) =>
  `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** Accepts 07:00, 7:00 AM, 19:40, 7:40:00 PM, and fractional-day numbers. */
export function normalizeTime(raw: string): string | null {
  const s = String(raw).trim();
  if (!s) return null;
  // Minutes are optional when a meridiem says what is meant: a person filling
  // in a spreadsheet writes "7 PM", and refusing to read it means a skipped
  // row and a missing slot. A bare "7" stays unreadable on purpose — it could
  // as easily be an hour count or a rink number.
  const m = /^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*([AaPp])\.?[Mm]?\.?$/.exec(s)
    ?? /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp])?\.?[Mm]?\.?$/.exec(s);
  if (m) {
    let h = +m[1]!;
    const mi = +(m[2] ?? 0);
    const ap = m[4]?.toLowerCase();
    if (ap === 'p' && h < 12) h += 12;
    if (ap === 'a' && h === 12) h = 0;
    if (h > 23 || mi > 59) return null;
    return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
  }
  if (/^0?\.\d+$/.test(s)) {
    const mins = Math.round(parseFloat(s) * 1440);
    return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
  }
  return null;
}

/** "#29" -> 29, "No preference" -> null, 99 outside range -> null. */
export function normalizeJerseyNumber(raw: unknown, min = 1, max = 98): number | null {
  if (raw === null || raw === undefined) return null;
  const m = /\d+/.exec(String(raw));
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

export function minutesBetween(start: string, end: string, fallback = 60): number {
  const a = toMin(start), b = toMin(end);
  if (a === null || b === null) return fallback;
  const d = b - a;
  return d > 0 ? d : fallback;
}
const toMin = (t: string) => {
  const n = normalizeTime(t);
  if (!n) return null;
  const [h, m] = n.split(':').map(Number) as [number, number];
  return h * 60 + m;
};

export function slugify(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
