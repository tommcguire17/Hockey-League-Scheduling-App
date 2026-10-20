import type { Season } from '@league/core';
import { fmtDay, fmtTime, gameWhen, iceDifferences, repurposedSlots } from '@league/core';
import { toCsv } from './csv.js';

/**
 * The CSVs people open. Written once and used by both the CLI and the
 * console, because two copies of "what goes in the schedule file" is how the
 * two start disagreeing.
 */

function placedGames(season: Season) {
  const slot = new Map(season.slots.map((s) => [s.id, s]));
  return season.games
    .map((g) => ({ g, w: gameWhen(g, slot) }))
    .filter((x): x is { g: typeof x.g; w: NonNullable<typeof x.w> } => !!x.w)
    .sort((a, b) => (a.w.date + a.w.start).localeCompare(b.w.date + b.w.start));
}

const teamNames = (season: Season) => new Map(season.teams.map((t) => [t.id, t.name]));
/**
 * Divisions by the name the rink gave them. A file that says "D1" where the
 * console says "8U" is a file somebody has to translate before they can use
 * it, and translating it is how the two drift apart.
 */
const divisionNames = (season: Season) =>
  new Map(season.divisions.map((d) => [d.id, d.name]));

/** Date order, day names, scores where they exist. The one to send coaches. */
export function exportScheduleCsv(season: Season): string {
  const name = teamNames(season);
  const div = divisionNames(season);
  const who = (id: string | null, label: string) => (id ? name.get(id) ?? id : label);
  const rows: (string | number)[][] = [[
    '#', 'Date', 'Day', 'Time', 'Rink', 'Division', 'Home', 'Visitor',
    'Home Goals', 'Visitor Goals', 'Type', 'Where',
  ]];
  placedGames(season).forEach(({ g, w }, i) => {
    rows.push([
      i + 1, w.date, fmtDay(w.date), fmtTime(w.start), w.rink,
      div.get(g.divisionId) ?? g.divisionId,
      who(g.homeTeamId, g.homeLabel), who(g.awayTeamId, g.awayLabel),
      g.homeGoals ?? '', g.awayGoals ?? '', g.type, w.away ? 'Away' : 'Home',
    ]);
  });
  return toCsv(rows);
}

/** Booked ice with nothing on it. What you can release or sell. */
export function exportUnusedIceCsv(season: Season): string {
  const used = new Set<string>();
  for (const g of season.games) if (g.slotId) used.add(g.slotId);
  for (const p of season.practices) if (p.teamIds.length) used.add(p.slotId);
  const rows: (string | number)[][] = [['Date', 'Day', 'Time', 'Rink', 'Minutes', 'Use']];
  for (const s of season.slots.filter((x) => !used.has(x.id))) {
    rows.push([s.date, fmtDay(s.date), fmtTime(s.start), s.rink, s.minutes, s.use]);
  }
  return toCsv(rows);
}

/** Every move, with the reason. */
export function exportChangesCsv(season: Season): string {
  const name = teamNames(season);
  const who = (id: string | null, label: string) => (id ? name.get(id) ?? id : label);
  const where = (p: { date: string | null; start: string | null; rink: string }) =>
    (p.date ? `${p.date} ${p.start ? fmtTime(p.start) : ''} ${p.rink}`.trim() : 'not scheduled');
  const rows: (string | number)[][] = [['Recorded', 'Game', 'Was', 'Now', 'Reason', 'Note']];
  for (const c of season.changes) {
    const g = season.games.find((x) => x.id === c.gameId);
    rows.push([
      c.at.slice(0, 16).replace('T', ' '),
      g ? `${who(g.homeTeamId, g.homeLabel)} v ${who(g.awayTeamId, g.awayLabel)}` : c.gameId,
      where(c.from), where(c.to), c.reason, c.note,
    ]);
  }
  return toCsv(rows);
}

/**
 * Where the booking system and the schedule disagree.
 *
 * This is the list that goes back to whoever keeps Finnly: the 7am Sunday
 * sheet booked as an 8U game is running the evaluation skate, and the front
 * desk needs to know that before a parent asks them.
 */
export function exportIceDifferencesCsv(season: Season): string {
  const rows: (string | number)[][] = [[
    'Date', 'Day', 'Start', 'Minutes', 'Rink',
    'Booked as', 'Being used as', 'Division', 'On the ice', 'Why',
  ]];
  for (const d of iceDifferences(season)) {
    rows.push([
      d.date, fmtDay(d.date), fmtTime(d.start), d.minutes, d.rink,
      label(d.bookedAs), label(d.usedAs), d.division, d.onTheIce, d.note,
    ]);
  }
  return toCsv(rows);
}

/** How many sheets are being used for something other than their booking. */
export const repurposedCount = (season: Season): number => repurposedSlots(season).length;

const label = (u: string) => (u === 'unused' ? 'Out of play' : u[0]!.toUpperCase() + u.slice(1));

/** How many slots are sitting idle, and how many hours that is. */
export function unusedIceSummary(season: Season): { slots: number; hours: number } {
  const used = new Set<string>();
  for (const g of season.games) if (g.slotId) used.add(g.slotId);
  for (const p of season.practices) if (p.teamIds.length) used.add(p.slotId);
  const free = season.slots.filter((s) => !used.has(s.id));
  return { slots: free.length, hours: free.reduce((n, s) => n + s.minutes, 0) / 60 };
}
