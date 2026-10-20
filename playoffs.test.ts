import { describe, it, expect } from 'vitest';
import {
  Season, HOUSE_LEAGUE, MIDDLE_SCHOOL_LEAGUE, PLAYOFF_TYPES, bracketRounds,
  gameWhen, validateSeason,
} from '@league/core';
import { generatePlayoffs, playoffIceAvailable } from '@league/engine';

/**
 * A regular season that finishes 4 February — played at other rinks, so it
 * holds none of our ice — then free game slots in March, two on each night.
 * Enough for any bracket this app builds.
 */
const season = (opts: { playoffTeams?: number; marchSlots?: number; consolation?: boolean } = {}) => {
  const marchNights = opts.marchSlots ?? 4;
  const slots = [
    ...Array.from({ length: marchNights }, (_, n) => [0, 1].map((k) => ({
      id: `mar${n}-${k}`, date: `2027-03-0${n + 1}`,
      start: k ? '19:30' : '18:00', minutes: 60, rink: 'R', use: 'game',
    }))).flat(),
  ];
  const teams = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
  const games = teams.flatMap((h, i) => teams.slice(i + 1).map((a, j) => ({
    id: `r${i}-${j}`, divisionId: 'D', slotId: null, homeTeamId: h, awayTeamId: a,
    homeGoals: 1, awayGoals: 0,
    away: { facility: 'Elsewhere', city: 'X', date: '2027-02-04', start: '18:00', minutes: 60 },
  })));
  return Season.parse({
    id: 's', name: 'S', leagueId: 'house', startDate: '2027-01-01', endDate: '2027-03-31',
    divisions: [{
      id: 'D', name: 'Div', gamesPerTeam: 7, practicesPerTeam: 0,
      playoffTeams: opts.playoffTeams ?? 4,
    }],
    teams: teams.map((n) => ({ id: n, divisionId: 'D', name: n })),
    slots, games,
    // These tests are about bracket shapes and finding ice for them, so the
    // fixture plays the full four-game bracket. Whether a league plays for
    // third is its own decision and lives on the season; the default is off.
    playoffConsolation: opts.consolation ?? true,
  });
};

const built = (opts?: Parameters<typeof season>[0], gen?: Parameters<typeof generatePlayoffs>[2]) => {
  const s = season(opts);
  const { games, report } = generatePlayoffs(s, HOUSE_LEAGUE, gen);
  return { season: { ...s, games }, report };
};

describe('generatePlayoffs', () => {
  it('builds the bracket and finds it ice', () => {
    const { season: s, report } = built();
    expect(report.needed).toBe(4);
    expect(report.placed).toBe(4);
    expect(report.issues).toEqual([]);
    const po = s.games.filter((g) => PLAYOFF_TYPES.has(g.type));
    expect(po.length).toBe(4);
    expect(po.every((g) => g.slotId)).toBe(true);
  });

  it('starts after the regular season, never during it', () => {
    const { season: s } = built();
    const slot = new Map(s.slots.map((x) => [x.id, x]));
    const po = s.games.filter((g) => PLAYOFF_TYPES.has(g.type));
    expect(po.every((g) => gameWhen(g, slot)!.date > '2027-02-04')).toBe(true);
  });

  it('runs a round on one night when the ice allows', () => {
    const { season: s } = built();
    const slot = new Map(s.slots.map((x) => [x.id, x]));
    const [sfs, finals] = bracketRounds(s, 'D');
    expect(new Set(sfs!.map((g) => gameWhen(g, slot)!.date)).size).toBe(1);
    expect(new Set(finals!.map((g) => gameWhen(g, slot)!.date)).size).toBe(1);
  });

  it('never starts a round before the round that decides it', () => {
    for (const playoffTeams of [2, 3, 4, 6, 8]) {
      const { season: s, report } = built({ playoffTeams });
      expect(report.issues).toEqual([]);
      const slot = new Map(s.slots.map((x) => [x.id, x]));
      const byId = new Map(s.games.map((g) => [g.id, g]));
      for (const g of s.games.filter((x) => PLAYOFF_TYPES.has(x.type))) {
        for (const src of [g.homeFrom, g.awayFrom]) {
          if (!src || src.kind === 'seed') continue;
          const feeder = byId.get(src.gameId!)!;
          expect(gameWhen(feeder, slot)!.date < gameWhen(g, slot)!.date).toBe(true);
        }
      }
    }
  });

  it('honours rest days between rounds', () => {
    const { season: s, report } = built({ playoffTeams: 4 }, { restDays: 1 });
    expect(report.issues).toEqual([]);
    const slot = new Map(s.slots.map((x) => [x.id, x]));
    const [sfs, finals] = bracketRounds(s, 'D');
    const sfDate = gameWhen(sfs![0]!, slot)!.date;
    const fDate = gameWhen(finals![0]!, slot)!.date;
    expect(Number(fDate.slice(-2)) - Number(sfDate.slice(-2))).toBeGreaterThanOrEqual(2);
  });

  it('takes no slot a regular game or a practice is already using', () => {
    const s = season();
    const held = { ...s, games: [...s.games, {
      ...s.games[0]!, id: 'late', slotId: 'mar0-0', away: null,
    }] };
    const { games } = generatePlayoffs(held, HOUSE_LEAGUE);
    const po = games.filter((g) => PLAYOFF_TYPES.has(g.type));
    expect(po.some((g) => g.slotId === 'mar0-0')).toBe(false);
  });

  it('reports the shortfall rather than quietly dropping a round', () => {
    const { report, season: s } = built({ playoffTeams: 8, marchSlots: 1 });
    expect(report.placed).toBeLessThan(report.needed);
    expect(report.issues.join(' ')).toMatch(/no ice/);
    // The games still exist, so the checks can point at what is missing.
    expect(s.games.filter((g) => PLAYOFF_TYPES.has(g.type)).length).toBe(8);
    expect(validateSeason(s, HOUSE_LEAGUE).violations.map((v) => v.code))
      .toContain('PLAYOFF_NO_ICE');
  });

  it('is a replacement, not an addition', () => {
    const once = built().season;
    const twice = generatePlayoffs(once, HOUSE_LEAGUE);
    expect(twice.games.filter((g) => PLAYOFF_TYPES.has(g.type)).length).toBe(4);
    expect(twice.report.placed).toBe(4);
  });

  it('seeds the bracket as it builds it', () => {
    const { season: s } = built();
    const sf1 = s.games.find((g) => g.id === 'po-D-sf1')!;
    expect([sf1.homeTeamId, sf1.awayTeamId]).toEqual(['A', 'D']);
  });

  it('declines in a league that does not run playoffs', () => {
    const s = season();
    const r = generatePlayoffs({ ...s, leagueId: 'middle_school' }, MIDDLE_SCHOOL_LEAGUE);
    expect(r.games.filter((g) => PLAYOFF_TYPES.has(g.type)).length).toBe(0);
    expect(r.report.issues[0]).toMatch(/does not run playoffs/);
  });

  it('says no rather than guessing at a bracket size it does not draw', () => {
    const { report } = built({ playoffTeams: 5 });
    expect(report.placed).toBe(0);
    expect(report.issues.join(' ')).toMatch(/not a bracket shape/);
  });

  it('refuses to qualify more teams than the division has', () => {
    const s = season({ playoffTeams: 8 });
    const small = { ...s, teams: s.teams.slice(0, 4) };
    const { report } = generatePlayoffs(small, HOUSE_LEAGUE);
    expect(report.issues.join(' ')).toMatch(/only 4 teams/);
  });

  it('leaves a clean validator behind on the ordinary case', () => {
    const { season: s } = built();
    const v = validateSeason(s, HOUSE_LEAGUE);
    const bracketCodes = v.violations
      .filter((x) => x.code.startsWith('PLAYOFF'))
      .map((x) => x.code);
    expect(bracketCodes).toEqual([]);
  });

  it('reports the ice left over so spare March nights can be released', () => {
    const { report } = built();
    expect(report.spareSlots).toBe(4);
  });
});

describe('playoffIceAvailable', () => {
  it('counts the playable slots after the regular season, by night', () => {
    const nights = playoffIceAvailable(season(), HOUSE_LEAGUE);
    expect(nights.map((n) => n.slots)).toEqual([2, 2, 2, 2]);
    expect(nights[0]!.date).toBe('2027-03-01');
  });

  it('skips a blacked-out night', () => {
    const s = season();
    const nights = playoffIceAvailable(
      { ...s, blackoutDates: ['2027-03-01'] }, HOUSE_LEAGUE);
    expect(nights.map((n) => n.date)).not.toContain('2027-03-01');
  });
});

describe('the third-place game is the season\'s decision', () => {
  it('is off unless the season says otherwise', () => {
    // It lives on the season rather than in the Playoffs tab's own state
    // because the generator reads the same answer when it decides how much
    // ice to hold back. The two guessing separately cost a night of ice.
    const off = built({ consolation: false });
    expect(off.report.needed).toBe(3);
    expect(off.season.games.some((g) => g.type === 'consolation')).toBe(false);
  });

  it('is played when it does', () => {
    const on = built({ consolation: true });
    expect(on.report.needed).toBe(4);
    expect(on.season.games.some((g) => g.type === 'consolation')).toBe(true);
  });

  it('can still be overridden for one build', () => {
    const forced = built({ consolation: true }, { consolation: false });
    expect(forced.report.needed).toBe(3);
  });
});
