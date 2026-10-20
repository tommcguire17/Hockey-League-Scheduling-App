import { describe, it, expect } from 'vitest';
import {
  Season, validateSeason, manifestFor, HOUSE_LEAGUE, MIDDLE_SCHOOL_LEAGUE, weekKey,
} from '@league/core';
import { generateSchedule } from '@league/engine';

/** Fri/Sat/Sun evening slots across `weeks` weeks, mirroring the real MSL ice. */
function mslSeason(over: Record<string, unknown> = {}) {
  const slots: unknown[] = [];
  let d = new Date(Date.UTC(2026, 11, 4)); // Friday 2026-12-04
  for (let w = 0; w < 16; w++) {
    for (const [off, times] of [[0, ['19:30', '20:30']], [1, ['19:00', '20:10']],
                                [2, ['19:00', '20:00', '20:30']]] as [number, string[]][]) {
      const day = new Date(d.getTime() + off * 86400000).toISOString().slice(0, 10);
      for (const [i, t] of times.entries()) {
        slots.push({ id: `s${w}-${off}-${i}`, date: day, start: t, minutes: 80,
          rink: i % 2 ? 'Rocky' : 'Red Hawk', use: 'game' });
      }
    }
    d = new Date(d.getTime() + 7 * 86400000);
  }
  const mk = (p: string, n: number, div: string) =>
    Array.from({ length: n }, (_, i) => ({ id: `${p}${i + 1}`, divisionId: div, name: `${p}${i + 1}` }));
  return Season.parse({
    id: 'msl', name: 'MSL', leagueId: 'middle_school',
    startDate: '2026-12-01', endDate: '2027-03-31',
    divisions: [
      { id: 'Lower', name: 'Lower', gamesPerTeam: 10, practicesPerTeam: 0 },
      { id: 'Upper', name: 'Upper', gamesPerTeam: 10, practicesPerTeam: 0 },
    ],
    teams: [...mk('L', 8, 'Lower'), ...mk('U', 6, 'Upper')],
    slots, games: [], practices: [], people: [],
    ...over,
  });
}

const M = MIDDLE_SCHOOL_LEAGUE;

describe('generateSchedule', () => {
  const season = mslSeason();
  const { games, report } = generateSchedule(season, M, { seed: 1, iterations: 30000 });
  const out = { ...season, games };
  const slot = new Map(season.slots.map((s) => [s.id, s]));

  it('places every fixture', () => {
    expect(report.unplaced).toEqual([]);
    expect(games.length).toBe(70);
  });

  it('produces a season with no validation errors', () => {
    const r = validateSeason(out, M);
    expect(r.violations.filter((v) => v.severity === 'error')).toEqual([]);
  });

  it('gives every team its exact game count', () => {
    const n = new Map<string, number>();
    for (const g of games) {
      n.set(g.homeTeamId!, (n.get(g.homeTeamId!) ?? 0) + 1);
      n.set(g.awayTeamId!, (n.get(g.awayTeamId!) ?? 0) + 1);
    }
    expect([...n.values()]).toEqual(new Array(14).fill(10));
  });

  it('keeps home and away even for every team', () => {
    const h = new Map<string, number>();
    for (const t of season.teams) h.set(t.id, 0);
    for (const g of games) h.set(g.homeTeamId!, h.get(g.homeTeamId!)! + 1);
    expect([...h.values()]).toEqual(new Array(14).fill(5));
  });

  it('never schedules a team twice in one week', () => {
    const seen = new Map<string, Set<string>>();
    for (const g of games) {
      const wk = weekKey(slot.get(g.slotId!)!.date, M.week.startsOn);
      for (const t of [g.homeTeamId!, g.awayTeamId!]) {
        const s = seen.get(t) ?? seen.set(t, new Set()).get(t)!;
        expect(s.has(wk)).toBe(false);
        s.add(wk);
      }
    }
  });

  it('never puts two teams from different divisions against each other', () => {
    const div = new Map(season.teams.map((t) => [t.id, t.divisionId]));
    for (const g of games) expect(div.get(g.homeTeamId!)).toBe(div.get(g.awayTeamId!));
  });

  it('never uses one slot twice', () => {
    const ids = games.map((g) => g.slotId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('avoids back-to-back meetings with the same opponent', () => {
    expect(report.longestRepeatRun).toBe(1);
  });

  it('is deterministic for a given seed, and different for another', () => {
    const a = generateSchedule(season, M, { seed: 7, iterations: 5000 }).games;
    const b = generateSchedule(season, M, { seed: 7, iterations: 5000 }).games;
    expect(a).toEqual(b);
    const c = generateSchedule(season, M, { seed: 8, iterations: 5000 }).games;
    expect(c).not.toEqual(a);
  });

  it('honours league-wide blackout dates', () => {
    const black = ['2026-12-25', '2026-12-26', '2026-12-27', '2027-01-01', '2027-01-02', '2027-01-03'];
    const s = mslSeason({ blackoutDates: black });
    const g = generateSchedule(s, M, { seed: 3, iterations: 20000 }).games;
    const sl = new Map(s.slots.map((x) => [x.id, x]));
    for (const x of g) expect(black).not.toContain(sl.get(x.slotId!)!.date);
    expect(validateSeason({ ...s, games: g }, M).violations.map((v) => v.code))
      .not.toContain('LEAGUE_BLACKOUT_VIOLATED');
  });

  it('honours a per-team blackout date', () => {
    const s = mslSeason();
    s.teams[0]!.blackoutDates = ['2026-12-04', '2026-12-05', '2026-12-06',
                                 '2026-12-11', '2026-12-12', '2026-12-13'];
    const g = generateSchedule(s, M, { seed: 4, iterations: 20000 }).games;
    const sl = new Map(s.slots.map((x) => [x.id, x]));
    for (const x of g) {
      if (x.homeTeamId === 'L1' || x.awayTeamId === 'L1') {
        expect(s.teams[0]!.blackoutDates).not.toContain(sl.get(x.slotId!)!.date);
      }
    }
  });

  it('never plays on a weekday the manifest forbids', () => {
    const bad = games.filter((g) => {
      const d = new Date(slot.get(g.slotId!)!.date + 'T00:00:00Z').getUTCDay();
      return d !== 5 && d !== 6 && d !== 0; // Fri, Sat, Sun
    });
    expect(bad).toEqual([]);
  });

  it('reports fixtures it could not place rather than dropping them', () => {
    const tiny = mslSeason({ slots: mslSeason().slots.slice(0, 10) });
    const r = generateSchedule(tiny, M, { seed: 5, iterations: 2000 });
    expect(r.games.length).toBe(10);
    expect(r.report.unplaced.length).toBe(60);
  });
});

describe('robustness', () => {
  it('still places all 70 games when a whole week is blacked out', () => {
    const s = mslSeason({ blackoutDates: ['2027-02-05', '2027-02-06', '2027-02-07'] });
    const r = generateSchedule(s, M, { seed: 11, iterations: 20000 });
    expect(r.report.unplaced).toEqual([]);
    expect(r.games.length).toBe(70);
  });

  it('holds up across many seeds', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const s = mslSeason();
      const r = generateSchedule(s, M, { seed, iterations: 15000 });
      expect(r.report.unplaced, `seed ${seed}`).toEqual([]);
      expect(r.report.longestRepeatRun, `seed ${seed}`).toBeLessThanOrEqual(2);
      const v = validateSeason({ ...s, games: r.games }, M);
      expect(v.violations.filter((x) => x.severity === 'error'), `seed ${seed}`).toEqual([]);
    }
  });

  it('moves the local search rather than being vetoed on every proposal', () => {
    const r = generateSchedule(mslSeason(), M, { seed: 2, iterations: 20000 });
    expect(r.report.movesAccepted).toBeGreaterThan(100);
  });
});

describe('away games and locked games', () => {
  const base = mslSeason();

  it('keeps an away game exactly where it is and counts it', () => {
    const s = {
      ...base,
      games: [{
        id: 'fixed-1', divisionId: 'Upper', slotId: null,
        homeTeamId: 'U1', awayTeamId: 'U2', homeLabel: '', awayLabel: '',
        type: 'regular' as const, homeGoals: null, awayGoals: null, locked: false,
        away: { facility: 'Codey Arena', city: 'West Orange',
                date: '2027-01-16', start: '17:00', minutes: 75 },
      }],
    };
    const r = generateSchedule(s, M, { seed: 21, iterations: 20000 });
    const kept = r.games.find((g) => g.id === 'fixed-1')!;
    expect(kept.away?.facility).toBe('Codey Arena');
    expect(kept.slotId).toBeNull();
    expect(r.report.kept).toBe(1);
    // the division total still comes out right rather than double counting
    const upper = r.report.byDivision.find((d) => d.divisionId === 'Upper')!;
    expect(upper.placed).toBe(upper.fixtures);
    const n = new Map<string, number>();
    for (const g of r.games) {
      n.set(g.homeTeamId!, (n.get(g.homeTeamId!) ?? 0) + 1);
      n.set(g.awayTeamId!, (n.get(g.awayTeamId!) ?? 0) + 1);
    }
    expect([...n.values()]).toEqual(new Array(14).fill(10));
  });

  it('does not give a team home ice in a week it already plays away', () => {
    const s = {
      ...base,
      games: [{
        id: 'fixed-1', divisionId: 'Upper', slotId: null,
        homeTeamId: 'U1', awayTeamId: 'U2', homeLabel: '', awayLabel: '',
        type: 'regular' as const, homeGoals: null, awayGoals: null, locked: false,
        away: { facility: 'Codey Arena', city: '', date: '2027-01-16', start: '17:00', minutes: 75 },
      }],
    };
    const r = generateSchedule(s, M, { seed: 22, iterations: 20000 });
    const slot = new Map(s.slots.map((x) => [x.id, x]));
    const wk = weekKey('2027-01-16', M.week.startsOn);
    for (const g of r.games) {
      if (!g.slotId) continue;
      if (g.homeTeamId !== 'U1' && g.awayTeamId !== 'U1'
        && g.homeTeamId !== 'U2' && g.awayTeamId !== 'U2') continue;
      expect(weekKey(slot.get(g.slotId)!.date, M.week.startsOn)).not.toBe(wk);
    }
    expect(validateSeason({ ...s, games: r.games }, M)
      .violations.filter((v) => v.severity === 'error')).toEqual([]);
  });

  it('never moves a locked game', () => {
    const first = generateSchedule(base, M, { seed: 30, iterations: 8000 }).games;
    const pin = { ...first[5]!, locked: true };
    const r = generateSchedule({ ...base, games: [pin] }, M, { seed: 31, iterations: 8000 });
    const after = r.games.find((g) => g.id === pin.id)!;
    expect(after.slotId).toBe(pin.slotId);
    expect(after.homeTeamId).toBe(pin.homeTeamId);
    expect(after.awayTeamId).toBe(pin.awayTeamId);
    expect(r.games.length).toBe(70);
  });

  it('never reuses the slot a locked game sits in', () => {
    const first = generateSchedule(base, M, { seed: 32, iterations: 8000 }).games;
    const pin = { ...first[9]!, locked: true };
    const r = generateSchedule({ ...base, games: [pin] }, M, { seed: 33, iterations: 8000 });
    expect(r.games.filter((g) => g.slotId === pin.slotId).length).toBe(1);
  });
});

describe('game ids', () => {
  it('never collides with the ids of games it kept', () => {
    // A season whose kept games are numbered high — playoffs written last by
    // the workbook import — used to be handed those same ids again as soon as
    // the generated range reached them.
    const s = Season.parse({
      id: 's', name: 'S', leagueId: 'house', startDate: '2027-01-01', endDate: '2027-04-30',
      divisions: [{ id: 'A', name: 'A', gamesPerTeam: 6, practicesPerTeam: 0 }],
      teams: [1, 2, 3, 4].map((i) => ({ id: `A-${i}`, divisionId: 'A', name: `A ${i}` })),
      slots: Array.from({ length: 20 }, (_, i) => ({
        id: `s${i}`, date: `2027-0${1 + Math.floor(i / 10)}-${String((i % 10) + 1).padStart(2, '0')}`,
        start: '12:00', minutes: 60, rink: 'R', use: 'game',
      })),
      // Kept games numbered g001 and g002 — right where the generator starts.
      games: [
        {
          id: 'g001', divisionId: 'A', slotId: null, homeTeamId: 'A-1', awayTeamId: 'A-2',
          locked: false,
          away: { facility: 'Elsewhere', city: 'X', date: '2027-01-01', start: '12:00', minutes: 60 },
        },
        {
          id: 'g002', divisionId: 'A', slotId: null, homeTeamId: 'A-3', awayTeamId: 'A-4',
          locked: false,
          away: { facility: 'Elsewhere', city: 'X', date: '2027-01-02', start: '12:00', minutes: 60 },
        },
      ],
    });
    const { games } = generateSchedule(s, HOUSE_LEAGUE, { seed: 4 });
    expect(new Set(games.map((g) => g.id)).size).toBe(games.length);
    expect(games.filter((g) => g.id === 'g001')).toHaveLength(1);
  });
});
