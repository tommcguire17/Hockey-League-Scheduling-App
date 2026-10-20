import type { Season } from '@league/core';
import { gameWhen, fmtTime } from '@league/core';
import { toCsv } from './csv.js';

/**
 * SportNinja schedule upload.
 * Header and column order are the contract; a golden-file test pins them.
 * CRLF line endings, as the importer expects.
 */
export const SPORTNINJA_HEADER = [
  'SN Game ID', 'Number', 'Home', 'Visitor', 'Date', 'Time',
  'Location', 'Facility', 'City', 'Game Type',
] as const;

export interface SportNinjaOptions {
  /** Facility name sent for every row, e.g. the arena. */
  venue: string;
  city: string;
  /** Include playoff games. Default true. */
  includePlayoffs?: boolean;
}

export function exportSportNinja(season: Season, opts: SportNinjaOptions): string {
  const slot = new Map(season.slots.map((s) => [s.id, s]));
  const team = new Map(season.teams.map((t) => [t.id, t.name]));
  const include = opts.includePlayoffs ?? true;

  const rows: (string | number)[][] = [SPORTNINJA_HEADER.slice() as unknown as string[]];
  let n = 0;

  const placed = season.games
    .map((g) => ({ g, w: gameWhen(g, slot) }))
    .filter((x): x is { g: typeof x.g; w: NonNullable<typeof x.w> } => !!x.w)
    .filter((x) => include || x.g.type === 'regular')
    .sort((a, b) => (a.w.date + a.w.start).localeCompare(b.w.date + b.w.start));

  for (const { g, w } of placed) {
    n++;
    rows.push([
      '',                                   // SN Game ID: blank on create
      n,                                    // Number
      g.homeTeamId ? team.get(g.homeTeamId) ?? g.homeTeamId : g.homeLabel,
      g.awayTeamId ? team.get(g.awayTeamId) ?? g.awayTeamId : g.awayLabel,
      formatDate(w.date),
      fmtTime(w.start),
      // Checked against SportNinja's own template: Location is the BUILDING,
      // Facility is the sheet of ice. Getting these the wrong way round was
      // the cost of building to the spec instead of to a real file.
      w.away ? w.rink : opts.venue,         // Location
      w.away ? '' : w.rink,                 // Facility
      w.away ? (g.away?.city ?? '') : opts.city,
      gameType(g.type),
    ]);
  }
  return toCsv(rows, '\r\n');
}

/**
 * SportNinja's own vocabulary, taken from its template:
 * Preliminary, Exhibition, Regular Season, Playoff. Anything finer than that
 * — semifinal, final — is still a Playoff as far as the importer is concerned.
 */
function gameType(t: string): string {
  switch (t) {
    case 'regular': return 'Regular Season';
    case 'exhibition': return 'Exhibition';
    default: return 'Playoff';
  }
}

/** SportNinja takes MM/DD/YYYY. */
function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-') as [string, string, string];
  return `${m}/${d}/${y}`;
}
/** and 12-hour time with AM/PM. */
