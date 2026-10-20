import { describe, it, expect } from 'vitest';
import {
  Season, ADULT_LEAGUE, HOUSE_LEAGUE, crossoverPool, mayCross, standings, validateSeason,
} from '@league/core';
import { crossFixtures, generateSchedule } from '@league/engine';

/** Four D-level divisions of four teams, the case this was built for. */
const adult = (crossGames = 3, over: Record<string, unknown> = {}) => {
  const divs = ['D1', 'D2', 'D3', 'D4'];
  return Season.parse({
    id: 'a', name: 'A', leagueId: 'adult',
    startDate: '2026-09-13', endDate: '2027-03-14',
    divisions: divs.map((id) => ({
      id, name: id, gamesPerTeam: 8, practicesPerTeam: 0,
      playsAcross: divs.filter((x) => x !== id), crossGamesPerTeam: crossGames,
    })),
    teams: divs.flatMap((d) => [1, 2, 3, 4].map((i) => ({
      id: `${d}-${i}`, divisionId: d, name: `${d} ${i}`,
    }))),
    slots: Array.from({ length: 120 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 8, 13 + Math.floor(i / 4) * 7 + (i % 4)));
      return {
        id: `s${i}`, date: d.toISOString().slice(0, 10),
        start: ['20:10', '21:20'][i % 2], minutes: 70,
        rink: i % 2 ? 'Rocky' : 'Red Hawk', use: 'game',
      };
    }),
    ...over,
  });
};

const divOf = (s: Season) => new Map(s.teams.map((t) => [t.id, t.divisionId]));

describe('crossFixtures', () => {
  const pool = (divs: number, per: number) =>
    Array.from({ length: divs }, (_, d) => `D${d + 1}`).flatMap((d) =>
      Array.from({ length: per }, (_, i) => ({ id: `${d}-${i + 1}`, divisionId: d })));

  it('gives every team exactly its share, none against its own division', () => {
    const teams = pool(4, 4);
    const r = crossFixtures(teams, new Map(teams.map((t) => [t.id, 2])));
    expect(r.short).toEqual([]);
    const per = new Map<string, number>();
    for (const f of r.fixtures) {
      expect(f.homeId.split('-')[0]).not.toBe(f.awayId.split('-')[0]);
      for (const t of [f.homeId, f.awayId]) per.set(t, (per.get(t) ?? 0) + 1);
    }
    expect([...new Set(per.values())]).toEqual([2]);
  });

  it('spreads across divisions instead of pairing the same two', () => {
    const teams = pool(4, 4);
    const r = crossFixtures(teams, new Map(teams.map((t) => [t.id, 3])));
    const pairs = new Set(r.fixtures.map((f) =>
      [f.homeId.split('-')[0], f.awayId.split('-')[0]].sort().join('v')));
    expect(pairs.size).toBe(6);                    // all six of the four divisions
  });

  it('balances home and away', () => {
    const teams = pool(3, 6);
    const r = crossFixtures(teams, new Map(teams.map((t) => [t.id, 2])));
    const home = new Map<string, number>();
    for (const f of r.fixtures) home.set(f.homeId, (home.get(f.homeId) ?? 0) + 1);
    expect([...new Set(teams.map((t) => home.get(t.id) ?? 0))]).toEqual([1]);
  });

  it('says who is short rather than failing on lopsided divisions', () => {
    const teams = [
      ...Array.from({ length: 6 }, (_, i) => ({ id: `BIG-${i}`, divisionId: 'BIG' })),
      ...Array.from({ length: 2 }, (_, i) => ({ id: `SML-${i}`, divisionId: 'SML' })),
    ];
    const r = crossFixtures(teams, new Map(teams.map((t) => [t.id, 2])));
    expect(r.short.length).toBeGreaterThan(0);
    expect(r.fixtures.length).toBeGreaterThan(0);
    for (const f of r.fixtures) {
      expect(f.homeId.split('-')[0]).not.toBe(f.awayId.split('-')[0]);
    }
  });
});

describe('crossover in a real season', () => {
  it('keeps the game total the same, with some of it across divisions', () => {
    const s = adult(3);
    const r = generateSchedule(s, ADULT_LEAGUE, { seed: 11 });
    const v = validateSeason({ ...s, games: r.games }, ADULT_LEAGUE);
    expect(v.errorCount).toBe(0);
    expect([...new Set(v.teams.map((t) => t.games))]).toEqual([8]);
    const d = divOf(s);
    const cross = r.games.filter((g) => d.get(g.homeTeamId!) !== d.get(g.awayTeamId!));
    expect(cross.length).toBe(r.report.crossGames);
    const per = new Map<string, number>();
    for (const g of cross) for (const t of [g.homeTeamId!, g.awayTeamId!]) {
      per.set(t, (per.get(t) ?? 0) + 1);
    }
    expect([...new Set(per.values())]).toEqual([3]);
  });

  it('files each crossover game under the home team, so the tables stay separate', () => {
    const s = adult(3);
    const r = generateSchedule(s, ADULT_LEAGUE, { seed: 11 });
    const d = divOf(s);
    for (const g of r.games) expect(g.divisionId).toBe(d.get(g.homeTeamId!));
    expect(standings({ ...s, games: r.games }, ADULT_LEAGUE)).toHaveLength(16);
  });

  it('plays nobody across when the count is zero', () => {
    const s = adult(0);
    const r = generateSchedule(s, ADULT_LEAGUE, { seed: 11 });
    const d = divOf(s);
    expect(r.report.crossGames).toBe(0);
    expect(r.games.every((g) => d.get(g.homeTeamId!) === d.get(g.awayTeamId!))).toBe(true);
  });
});

describe('the rules around crossover', () => {
  it('reads the pairing both ways, so half-set configuration still works', () => {
    const s = adult(0, {
      divisions: [
        { id: 'D1', name: 'D1', playsAcross: ['D2'] },
        { id: 'D2', name: 'D2', playsAcross: [] },
      ],
      teams: [], slots: [],
    });
    expect(mayCross(s.divisions[0]!, s.divisions[1]!)).toBe(true);
    expect(mayCross(s.divisions[1]!, s.divisions[0]!)).toBe(true);
  });

  it('treats crossover as transitive, so four divisions are one pool', () => {
    const s = adult(0, {
      divisions: [
        { id: 'A', name: 'A', playsAcross: ['B'] },
        { id: 'B', name: 'B', playsAcross: ['C'] },
        { id: 'C', name: 'C', playsAcross: [] },
        { id: 'Z', name: 'Z', playsAcross: [] },
      ],
      teams: [], slots: [],
    });
    expect(crossoverPool(s.divisions, 'A').map((d) => d.id)).toEqual(['A', 'B', 'C']);
    expect(crossoverPool(s.divisions, 'Z').map((d) => d.id)).toEqual(['Z']);
  });

  it('refuses a crossover between different ice formats', () => {
    const s = Season.parse({
      id: 'h', name: 'H', leagueId: 'house', startDate: '2027-01-01', endDate: '2027-03-01',
      divisions: [
        { id: '8U', name: '8U', iceFormat: 'cross', playsAcross: ['15U'] },
        { id: '15U', name: '15U', iceFormat: 'full', playsAcross: ['8U'] },
      ],
    });
    expect(validateSeason(s, HOUSE_LEAGUE).violations.map((v) => v.code))
      .toContain('CROSSOVER_FORMAT_MISMATCH');
  });

  it('still refuses a game between divisions that have not agreed to it', () => {
    const s = Season.parse({
      id: 'h', name: 'H', leagueId: 'house', startDate: '2027-01-01', endDate: '2027-03-01',
      divisions: [{ id: '8U', name: '8U' }, { id: '15U', name: '15U' }],
      teams: [{ id: '8U-1', divisionId: '8U', name: 'a' }, { id: '15U-1', divisionId: '15U', name: 'b' }],
      slots: [{ id: 's', date: '2027-01-10', start: '12:00', minutes: 60, rink: 'R', use: 'game' }],
      games: [{ id: 'g', divisionId: '8U', slotId: 's', homeTeamId: '8U-1', awayTeamId: '15U-1' }],
    });
    expect(validateSeason(s, HOUSE_LEAGUE).violations.map((v) => v.code))
      .toContain('CROSS_DIVISION_GAME');
  });

  it('allows the same game once the two divisions are paired', () => {
    const s = Season.parse({
      id: 'h', name: 'H', leagueId: 'house', startDate: '2027-01-01', endDate: '2027-03-01',
      divisions: [
        { id: 'D1', name: 'D1', playsAcross: ['D2'], crossGamesPerTeam: 1, gamesPerTeam: 2 },
        { id: 'D2', name: 'D2', playsAcross: ['D1'], crossGamesPerTeam: 1, gamesPerTeam: 2 },
      ],
      teams: [{ id: 'D1-1', divisionId: 'D1', name: 'a' }, { id: 'D2-1', divisionId: 'D2', name: 'b' }],
      slots: [{ id: 's', date: '2027-01-10', start: '12:00', minutes: 60, rink: 'R', use: 'game' }],
      games: [{ id: 'g', divisionId: 'D1', slotId: 's', homeTeamId: 'D1-1', awayTeamId: 'D2-1' }],
    });
    expect(validateSeason(s, HOUSE_LEAGUE).violations.map((v) => v.code))
      .not.toContain('CROSS_DIVISION_GAME');
  });

  it('objects to more crossover games than games', () => {
    const s = adult(0, {
      divisions: [
        { id: 'D1', name: 'D1', gamesPerTeam: 4, playsAcross: ['D2'], crossGamesPerTeam: 6 },
        { id: 'D2', name: 'D2', gamesPerTeam: 4, playsAcross: ['D1'], crossGamesPerTeam: 1 },
      ],
      teams: [], slots: [],
    });
    expect(validateSeason(s, ADULT_LEAGUE).violations.map((v) => v.code))
      .toContain('CROSSOVER_OVER_TARGET');
  });

  it('warns when a division wants crossover but has nobody paired', () => {
    const s = adult(0, {
      divisions: [{ id: 'D1', name: 'D1', gamesPerTeam: 4, crossGamesPerTeam: 2 }],
      teams: [], slots: [],
    });
    expect(validateSeason(s, ADULT_LEAGUE).violations.map((v) => v.code))
      .toContain('CROSSOVER_NO_PARTNER');
  });
});
