import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import {
  exportSportNinja, exportScheduleCsv, exportUnusedIceCsv, SPORTNINJA_HEADER,
  loadSeason, normalizeTime, saveSeason, parseCsv,
} from '@league/io';
import { validateSeason, HOUSE_LEAGUE } from '@league/core';

const season = loadSeason(readFileSync('fixtures/mini.season.json', 'utf8'));
const GOLDEN = 'fixtures/mini.sportninja.csv';

describe('SportNinja export', () => {
  const csv = exportSportNinja(season, { venue: season.venue, city: season.city });

  it('matches the golden file byte for byte', () => {
    // Regenerate deliberately with UPDATE_GOLDEN=1 when the format really changes.
    if (!existsSync(GOLDEN) || process.env.UPDATE_GOLDEN) writeFileSync(GOLDEN, csv);
    expect(csv).toBe(readFileSync(GOLDEN, 'utf8'));
  });

  it('keeps the exact header and column order SportNinja requires', () => {
    expect(parseCsv(csv)[0]).toEqual([...SPORTNINJA_HEADER]);
  });

  it('uses CRLF line endings', () => {
    expect(csv.includes('\r\n')).toBe(true);
    expect(csv.split('\r\n').length - 1).toBe(csv.split('\n').length - 1);
  });

  it('writes MM/DD/YYYY dates and 12-hour times', () => {
    const rows = parseCsv(csv);
    expect(rows[1]!.slice(4, 6)).toEqual(['01/09/2027', '9:00 AM']);
    const evening = rows.find((r) => r[5] === '8:00 PM');
    expect(evening).toBeDefined();
  });

  it('puts the building in Location and the sheet in Facility', () => {
    // Pinned against SportNinja's published template, where Location reads
    // "Montclair State University Ice Arena" and Facility reads "Rocky".
    const r = parseCsv(csv)[1]!;
    expect(r[6]).toBe('Example Ice Center');
    expect(r[7]).toBe('North');
  });

  it('uses only game types SportNinja recognises', () => {
    const allowed = new Set(['Preliminary', 'Exhibition', 'Regular Season', 'Playoff']);
    for (const r of parseCsv(csv).slice(1)) expect(allowed).toContain(r[9]!);
  });

  it('falls back to bracket labels when a playoff seed is unresolved', () => {
    const fin = parseCsv(csv).find((r) => r[9] === 'Playoff')!;
    expect(fin.slice(2, 4)).toEqual(['Seed 1', 'Seed 2']);
  });

  it('sends an away game with the other rink as the Location', () => {
    const withAway = {
      ...season,
      games: [...season.games, {
        id: 'ga', divisionId: 'A', slotId: null, homeTeamId: 'A-1', awayTeamId: 'A-2',
        homeLabel: '', awayLabel: '', type: 'regular' as const,
        homeGoals: null, awayGoals: null, locked: false,
        away: { facility: 'Codey Arena', city: 'West Orange',
                date: '2027-02-06', start: '18:30', minutes: 75 },
      }],
    };
    const row = parseCsv(exportSportNinja(withAway, { venue: 'Example Ice Center', city: 'Exampleton' }))
      .find((r) => r[4] === '02/06/2027')!;
    expect(row[6]).toBe('Codey Arena');
    expect(row[8]).toBe('West Orange');
  });

  it('can omit playoffs', () => {
    const reg = exportSportNinja(season, { venue: 'x', city: 'y', includePlayoffs: false });
    expect(parseCsv(reg).length).toBe(5); // header + 4 regular games
  });

  it('numbers games sequentially in date order', () => {
    const nums = parseCsv(csv).slice(1).map((r) => Number(r[1]));
    expect(nums).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('season round-trip', () => {
  it('load(save(x)) is identical to x', () => {
    expect(loadSeason(saveSeason(season, { includePeople: true }))).toEqual(season);
  });

  it('never writes people unless explicitly asked', () => {
    const withPeople = { ...season, people: [
      { id: 'p1', firstName: 'Test', lastName: 'CHILD', divisionId: null, teamId: null,
        birthDate: null, householdId: null, guardianName: '', guardianEmail: 'a@b.c',
        jerseyNumber: null, jerseySize: '', sockSize: '', numberPrefs: [], registeredAt: '' },
    ] };
    const def = JSON.parse(saveSeason(withPeople));
    expect(def.people).toEqual([]);
    expect(saveSeason(withPeople)).not.toContain('a@b.c');
    expect(saveSeason(withPeople, { includePeople: true })).toContain('a@b.c');
  });
});

describe('the fixture itself is a valid season', () => {
  it('has no errors', () => {
    const r = validateSeason(season, HOUSE_LEAGUE);
    expect(r.violations.filter((v) => v.severity === 'error')).toEqual([]);
  });
});

describe('the CSVs people open', () => {
  /**
   * These go to coaches and parents. A 24-hour clock in them is the bug Tom
   * reported from the other direction: a rink full of people reading 18:30
   * and arriving at half past six having done the arithmetic, or not.
   */
  const rows = parseCsv(exportScheduleCsv(season));
  const head = rows[0]!;
  const col = (name: string) => head.indexOf(name);

  it('writes times as 12-hour with AM or PM', () => {
    for (const r of rows.slice(1)) {
      expect(r[col('Time')]).toMatch(/^\d{1,2}:\d{2} [AP]M$/);
    }
  });

  it('writes the division by its name, not its id', () => {
    // Tom's case exactly: the division was imported as "D1" and renamed to
    // "8U". The id has to stay D1, because every game points at it; the file
    // has to say 8U, because that is what the league is called.
    const renamed = {
      ...season,
      divisions: season.divisions.map((d, i) => ({ ...d, id: d.id, name: i ? d.name : '8U' })),
    };
    const out = parseCsv(exportScheduleCsv(renamed));
    const c = out[0]!.indexOf('Division');
    const first = season.divisions[0]!.id;
    const mine = out.slice(1).filter((r) => r[c] === '8U');
    expect(mine.length).toBeGreaterThan(0);
    expect(out.slice(1).some((r) => r[c] === first)).toBe(false);
  });

  it('writes unused ice with readable times too', () => {
    const ice = parseCsv(exportUnusedIceCsv(season));
    for (const r of ice.slice(1)) {
      expect(r[ice[0]!.indexOf('Time')]).toMatch(/^\d{1,2}:\d{2} [AP]M$/);
    }
  });

  it('writes a time our own importer can read back', () => {
    // A 12-hour CSV is no use if re-importing it drops every row.
    for (const r of rows.slice(1)) {
      expect(normalizeTime(r[col('Time')]!)).toMatch(/^\d{2}:\d{2}$/);
    }
  });
});
