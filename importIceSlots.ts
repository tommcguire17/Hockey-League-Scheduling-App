import { Slot, type SlotUse } from '@league/core';
import { parseCsv, Header } from './csv.js';
import { normalizeDate, normalizeTime, normalizeRink, minutesBetween } from './normalize.js';

export interface ImportIssue { row: number; message: string; raw?: string }
export interface ImportResult<T> { items: T[]; issues: ImportIssue[]; skipped: number }

/**
 * What the Event Type column means.
 *
 * Finnly writes free text — "YHL Game", "YHL Practice", "YHL Evaluations -
 * u10" — and that text is the only place the booking says what the ice is
 * for. Reading it was the whole point of asking for the column; the importer
 * used to store it as a tag and set every slot to 'game' regardless, which is
 * why an import of 78 practices came back as 78 games.
 */
export function useFromEventType(raw: string): SlotUse | null {
  const t = raw.toLowerCase();
  if (!t.trim()) return null;
  // Order matters: "evaluation" is checked first because an eval line often
  // also contains the word that would otherwise read as a practice.
  if (/\beval/.test(t)) return 'evaluation';
  if (/\bpractice|\bprac\b|\bskat|\bclinic|\bcamp|\bdevelop|\bdrill/.test(t)) return 'practice';
  // Before the plain game test: a line that says playoff is game ice the
  // regular season may not have, which is a different thing from game ice.
  if (/\bplayoff|\bpost.?season|\bchampionship|\bquarterfinal|\bsemifinal|\bfinals?\b/
    .test(t)) return 'playoff';
  if (/\bgame|\bscrimmage|\bjamboree/.test(t)) return 'game';
  if (/\bunused|\bavailable|\bopen ice|\bhold\b|\bno use/.test(t)) return 'unused';
  return null;
}

/**
 * The division named inside an Event Type, when there is one.
 *
 * "YHL Evaluations - u10" carries the division as well as the use, so the
 * import can set the owner too rather than leaving Tom to tag five slots by
 * hand and hope he spotted them all.
 */
export function divisionFromEventType(raw: string, divisionIds: string[]): string | null {
  const t = raw.toLowerCase();
  // Prefer the longest id, so "u15" is not matched by a division called "u1".
  const byLength = [...divisionIds].sort((a, b) => b.length - a.length);
  for (const id of byLength) {
    const needle = id.toLowerCase();
    if (needle && new RegExp(`(^|[^a-z0-9])${needle}([^a-z0-9]|$)`).test(t)) return id;
  }
  // Fall back to a bare age-group token: u8, 10u, U12.
  const m = t.match(/(?:^|[^a-z0-9])(?:u\s?(\d{1,2})|(\d{1,2})\s?u)(?:[^a-z0-9]|$)/);
  if (!m) return null;
  const n = m[1] ?? m[2];
  const want = [`u${n}`, `${n}u`];
  return divisionIds.find((d) => want.includes(d.toLowerCase())) ?? null;
}

/**
 * Imports a booked-ice export (Finnly account schedule, or the rink report).
 * Expected columns, matched case-insensitively by any listed alias:
 *   Event Date | Event Start Time | Event End Time | Facility Name | Event Type
 */
export function importIceSlots(
  csv: string,
  opts: {
    idPrefix?: string;
    /** Used only when the Event Type column is missing or says nothing useful. */
    defaultUse?: SlotUse;
    /** Division ids to look for inside the Event Type, e.g. ['8U','10U']. */
    divisionIds?: string[];
  } = {},
): ImportResult<Slot> {
  const rows = parseCsv(csv);
  const issues: ImportIssue[] = [];
  if (rows.length < 2) return { items: [], issues: [{ row: 0, message: 'File has no data rows.' }], skipped: 0 };

  const h = new Header(rows[0]!, 'Ice slots');
  const cDate = h.require('Event Date', 'Date', 'Start Date');
  const cStart = h.require('Event Start Time', 'Start Time', 'Start');
  const cEnd = h.find('Event End Time', 'End Time', 'End');
  const cFac = h.find('Facility Name', 'Facility', 'Rink', 'Location', 'Resource');
  const cType = h.find('Event Type', 'Type', 'Use');

  const prefix = opts.idPrefix ?? 'slot';
  const divisionIds = opts.divisionIds ?? [];
  const items: Slot[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  const unread = new Map<string, number>();   // Event Type values we could not read

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]!;
    const date = normalizeDate(row[cDate] ?? '');
    const start = normalizeTime(row[cStart] ?? '');
    if (!date || !start) {
      skipped++;
      issues.push({ row: r + 1, message: 'Unreadable date or start time; row skipped.', raw: row.join(' | ') });
      continue;
    }
    const rink = normalizeRink(cFac >= 0 ? (row[cFac] ?? '') : '') || 'Unknown';
    const minutes = cEnd >= 0 ? minutesBetween(start, row[cEnd] ?? '', 60) : 60;
    const tag = cType >= 0 ? (row[cType] ?? '').trim() : '';

    const id = `${prefix}-${date}-${start.replace(':', '')}-${rink.replace(/\W+/g, '')}`;
    if (seen.has(id)) {
      issues.push({ row: r + 1, message: `Duplicate slot ${date} ${start} ${rink}; row skipped.` });
      skipped++;
      continue;
    }
    seen.add(id);

    const read = useFromEventType(tag);
    if (tag && !read) unread.set(tag, (unread.get(tag) ?? 0) + 1);
    const use = read ?? opts.defaultUse ?? 'game';
    const owner = tag ? divisionFromEventType(tag, divisionIds) : null;

    items.push(Slot.parse({
      id, date, start, minutes, rink, use,
      // What the building booked it as, kept so a later repurpose can be
      // seen, protected and handed back to whoever maintains Finnly.
      bookedUse: use,
      // 0 is auto: the format of whichever division plays on it decides.
      capacity: 0,
      // 0 is auto: however many teams the owning division needs that week.
      // Forcing 1 here is what made an age group's practice night hold one
      // team and leave the other three with nothing.
      practiceTeams: 0,
      ownerDivisionId: owner,
      // An evaluation sheet belongs to its division for good. Anything else a
      // division is named on gets first refusal, then releases.
      ownerPolicy: use === 'evaluation' ? 'exclusive' : 'priority',
      tag,
    }));
  }
  // Say what could not be read rather than silently calling it a game.
  for (const [value, n] of unread) {
    issues.push({
      row: 0,
      message: `Could not tell what "${value}" is for (${n} slot${n === 1 ? '' : 's'}); `
        + `treated as ${opts.defaultUse ?? 'game'}. Set it on Ice, or add the word `
        + 'game, practice or evaluation to the event type in Finnly.',
    });
  }
  items.sort((a, b) => (a.date + a.start + a.rink).localeCompare(b.date + b.start + b.rink));
  return { items, issues, skipped };
}
