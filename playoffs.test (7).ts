import { describe, it, expect } from 'vitest';
import {
  Season, HOUSE_LEAGUE, BRACKET_SIZES, bracketTemplate, bracketGameCount,
  bracketRounds, bracketProgress, clearPlayoffs, isBracketSize, resolveBracket,
  standings, validateSeason, MIDDLE_SCHOOL_LEAGUE, type BracketSize,
} from '@league/core';

/** Eight teams, eight dates, a finished regular season in a known order. */
const base = (games: unknown[] = []) => Season.parse({
  id: 's', name: 'S', leagueId: 'house', startDate: '2027-01-01', endDate: '2027-03-31',
  divisions: [{ id: 'D', name: 'D', gamesPerTeam: 0, practicesPerTeam: 0, playoffTeams: 4 }],
  teams: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((n) => ({ id: n, divisionId: 'D', name: n })),
  slots: Array.from({ length: 12 }, (_, i) => ({
    id: `s${i + 1}`, date: `2027-02-${String(i + 1).padStart(2, '0')}`,
    start: '18:00', minutes: 60, rink: 'R', use: 'game',
  })),
  games,
});

/** Wins engineered so the table reads A, B, C, D, E, F, G, H top to bottom. */
const ranked = () => {
  const order = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
  const games: unknown[] = [];
  let n = 0;
  for (let i = 0; i < order.length; i++) {
    for (let j = i + 1; j < order.length; j++) {
      n++;
      games.push({
        id: `r${n}`, divisionId: 'D', slotId: null,
        homeTeamId: order[i], awayTeamId: order[j],
        homeGoals: 1, awayGoals: 0,
        away: { facility: 'Elsewhere', city: 'X', date: '2027-01-15', start: '18:00', minutes: 60 },
      });
    }
  }
  return games;
};

const bracket = (
  size: BracketSize, consolation = true, divisionId = 'D',
) => bracketTemplate(size, consolation).map((n) => ({
  id: `po-${divisionId}-${n.code}`, divisionId, slotId: null,
  homeTeamId: null, awayTeamId: null, type: n.type,
  homeFrom: n.home.kind === 'seed' ? n.home : { ...n.home, gameId: `po-${divisionId}-${n.home.gameId}` },
  awayFrom: n.away.kind === 'seed' ? n.away : { ...n.away, gameId: `po-${divisionId}-${n.away.gameId}` },
}));

describe('bracket shapes', () => {
  it('only claims the sizes it can actually draw', () => {
    expect([...BRACKET_SIZES]).toEqual([2, 3, 4, 6, 8]);
    expect(isBracketSize(5)).toBe(false);
    expect(isBracketSize(8)).toBe(true);
  });

  it('counts games the way a rink would', () => {
    expect(bracketGameCount(2)).toBe(1);                 // final
    expect(bracketGameCount(3)).toBe(2);                 // play-in, final
    expect(bracketGameCount(4)).toBe(4);                 // 2 SF, final, third
    expect(bracketGameCount(4, false)).toBe(3);
    expect(bracketGameCount(6)).toBe(6);                 // 2 QF, 2 SF, final, third
    expect(bracketGameCount(8)).toBe(8);                 // 4 QF, 2 SF, final, third
  });

  it('never refers forward, so a bracket can be built in one pass', () => {
    for (const size of BRACKET_SIZES) {
      const t = bracketTemplate(size);
      const seen = new Set<string>();
      for (const n of t) {
        for (const src of [n.home, n.away]) {
          if (src.kind !== 'seed') expect(seen.has(src.gameId!)).toBe(true);
        }
        seen.add(n.code);
      }
    }
  });

  it('seeds every entrant exactly once and gives byes to the top', () => {
    for (const size of BRACKET_SIZES) {
      const seeds = bracketTemplate(size).flatMap((n) => [n.home, n.away])
        .filter((s) => s.kind === 'seed').map((s) => s.rank!);
      expect([...seeds].sort((a, b) => a - b)).toEqual(
        Array.from({ length: size }, (_, i) => i + 1));
    }
    // 6-team: 1 and 2 are the ones who skip the first round.
    const six = bracketTemplate(6);
    const r1 = six.filter((n) => n.round === 1).flatMap((n) => [n.home.rank, n.away.rank]);
    expect(r1.sort()).toEqual([3, 4, 5, 6]);
  });

  it('puts the better seed at home', () => {
    const four = bracketTemplate(4);
    expect(four[0]!.home.rank).toBe(1);
    expect(four[0]!.away.rank).toBe(4);
    expect(four[1]!.home.rank).toBe(2);
    expect(four[1]!.away.rank).toBe(3);
  });

  it('drops the third-place game when asked, and never offers one that cannot exist', () => {
    expect(bracketTemplate(4, false).some((n) => n.type === 'consolation')).toBe(false);
    for (const size of [2, 3] as const) {
      expect(bracketTemplate(size, true).some((n) => n.type === 'consolation')).toBe(false);
    }
  });
});

describe('resolveBracket', () => {
  it('seeds from the live table', () => {
    const s = resolveBracket(base([...ranked(), ...bracket(4)]), HOUSE_LEAGUE);
    const sf1 = s.games.find((g) => g.id === 'po-D-sf1')!;
    const sf2 = s.games.find((g) => g.id === 'po-D-sf2')!;
    expect([sf1.homeTeamId, sf1.awayTeamId]).toEqual(['A', 'D']);
    expect([sf2.homeTeamId, sf2.awayTeamId]).toEqual(['B', 'C']);
  });

  it('leaves the final empty until the semifinals are played', () => {
    const s = resolveBracket(base([...ranked(), ...bracket(4)]), HOUSE_LEAGUE);
    const f = s.games.find((g) => g.id === 'po-D-f')!;
    expect(f.homeTeamId).toBe(null);
    expect(f.homeLabel).toBe('Winner SF1');
    expect(f.awayLabel).toBe('Winner SF2');
  });

  it('advances the winner and drops the loser into the third-place game', () => {
    // Seed first, then play the semifinals, exactly as the console does.
    const seeded = resolveBracket(base([...ranked(), ...bracket(4)]), HOUSE_LEAGUE);
    const s0 = { ...seeded, games: seeded.games.map((g) =>
      (g.id === 'po-D-sf1' ? { ...g, homeGoals: 1, awayGoals: 4 }        // D beats A
        : g.id === 'po-D-sf2' ? { ...g, homeGoals: 3, awayGoals: 2 }     // B beats C
          : g)) };
    const s = resolveBracket(s0, HOUSE_LEAGUE);
    const f = s.games.find((g) => g.id === 'po-D-f')!;
    const c = s.games.find((g) => g.id === 'po-D-c')!;
    expect([f.homeTeamId, f.awayTeamId]).toEqual(['D', 'B']);
    expect([c.homeTeamId, c.awayTeamId]).toEqual(['A', 'C']);
  });

  it('refuses to advance anyone out of a tie', () => {
    const s0 = resolveBracket(base([...ranked(), ...bracket(4)]), HOUSE_LEAGUE);
    const tied = { ...s0, games: s0.games.map((g) =>
      (g.id === 'po-D-sf1' ? { ...g, homeGoals: 2, awayGoals: 2 } : g)) };
    const f = resolveBracket(tied, HOUSE_LEAGUE).games.find((g) => g.id === 'po-D-f')!;
    expect(f.homeTeamId).toBe(null);
  });

  it('is idempotent and returns the same object when nothing moved', () => {
    const once = resolveBracket(base([...ranked(), ...bracket(4)]), HOUSE_LEAGUE);
    expect(resolveBracket(once, HOUSE_LEAGUE)).toBe(once);
  });

  it('does not touch a bracket game that is locked or already played', () => {
    const s0 = base([...ranked(), ...bracket(4)]);
    const pinned = { ...s0, games: s0.games.map((g) =>
      (g.id === 'po-D-sf1' ? { ...g, homeTeamId: 'G', awayTeamId: 'H', locked: true } : g)) };
    const sf1 = resolveBracket(pinned, HOUSE_LEAGUE).games.find((g) => g.id === 'po-D-sf1')!;
    expect([sf1.homeTeamId, sf1.awayTeamId]).toEqual(['G', 'H']);
  });

  it('a score on a bracket game with no teams yet does not jam the bracket', () => {
    const s0 = base([...ranked(), ...bracket(4)]);
    const early = { ...s0, games: s0.games.map((g) =>
      (g.id === 'po-D-sf1' ? { ...g, homeGoals: 3, awayGoals: 1 } : g)) };
    const sf1 = resolveBracket(early, HOUSE_LEAGUE).games.find((g) => g.id === 'po-D-sf1')!;
    expect([sf1.homeTeamId, sf1.awayTeamId]).toEqual(['A', 'D']);
  });

  it('keeps bracket games out of the standings', () => {
    const s0 = base([...ranked(), ...bracket(4)]);
    const played = { ...s0, games: s0.games.map((g) =>
      (g.id === 'po-D-sf1' ? { ...g, homeTeamId: 'A', awayTeamId: 'D', homeGoals: 9, awayGoals: 0 } : g)) };
    const a = standings(played, HOUSE_LEAGUE).find((r) => r.teamId === 'A')!;
    expect(a.goalsFor).toBe(7);     // the seven regular wins, not the 9-0 semifinal
  });

  it('survives a bracket that feeds itself instead of looping forever', () => {
    const s0 = base([...ranked(), ...bracket(4)]);
    const cyclic = { ...s0, games: s0.games.map((g) =>
      (g.id === 'po-D-sf1'
        ? { ...g, homeFrom: { kind: 'winner' as const, rank: null, gameId: 'po-D-f' } } : g)) };
    expect(() => resolveBracket(cyclic, HOUSE_LEAGUE)).not.toThrow();
    expect(() => bracketRounds(cyclic, 'D')).not.toThrow();
  });
});

describe('bracketRounds and progress', () => {
  it('lays the bracket out from what feeds what', () => {
    const s = base([...ranked(), ...bracket(8)]);
    const rounds = bracketRounds(s, 'D');
    expect(rounds.map((r) => r.length)).toEqual([4, 2, 2]);
    expect(rounds[0]!.every((g) => g.type === 'quarterfinal')).toBe(true);
    expect(rounds[2]!.map((g) => g.type).sort()).toEqual(['consolation', 'final']);
  });

  it('names a champion only once the final is decided', () => {
    const s0 = base([...ranked(), ...bracket(4)]);
    expect(bracketProgress(s0, 'D').champion).toBe(null);
    const won = { ...s0, games: s0.games.map((g) =>
      (g.id === 'po-D-f' ? { ...g, homeTeamId: 'A', awayTeamId: 'B', homeGoals: 2, awayGoals: 1 } : g)) };
    expect(bracketProgress(won, 'D').champion).toBe('A');
  });

  it('clearPlayoffs takes the bracket and nothing else', () => {
    const s = clearPlayoffs(base([...ranked(), ...bracket(4)]));
    expect(s.games.length).toBe(28);
    expect(s.games.every((g) => g.type === 'regular')).toBe(true);
    expect(clearPlayoffs(s)).toBe(s);
  });
});

describe('the validator on brackets', () => {
  const codes = (s: ReturnType<typeof base>) =>
    validateSeason(s, HOUSE_LEAGUE).violations.map((v) => v.code);

  it('objects to a bracket size it cannot draw', () => {
    const s = base();
    expect(codes({ ...s, divisions: [{ ...s.divisions[0]!, playoffTeams: 5 }] }))
      .toContain('PLAYOFF_SIZE_UNSUPPORTED');
  });

  it('objects to qualifying more teams than the division has', () => {
    const s = base();
    const small = {
      ...s, teams: s.teams.slice(0, 2),
      divisions: [{ ...s.divisions[0]!, playoffTeams: 4 }],
    };
    expect(codes(small)).toContain('PLAYOFF_SIZE_EXCEEDS_TEAMS');
  });

  it('flags a bracket game with no ice', () => {
    expect(codes(base([...ranked(), ...bracket(4)]))).toContain('PLAYOFF_NO_ICE');
  });

  it('flags a round played before the round that decides it', () => {
    const s0 = base([...ranked(), ...bracket(4)]);
    const wrong = { ...s0, games: s0.games.map((g) =>
      (g.id === 'po-D-sf1' ? { ...g, slotId: 's9' }
        : g.id === 'po-D-sf2' ? { ...g, slotId: 's10' }
          : g.id === 'po-D-f' ? { ...g, slotId: 's8' }
            : g.id === 'po-D-c' ? { ...g, slotId: 's11' } : g)) };
    expect(codes(wrong)).toContain('PLAYOFF_ORDER');
  });

  it('warns while seeds can still move', () => {
    const s0 = base([...ranked(), ...bracket(4)]);
    const open = { ...s0, games: s0.games.map((g) =>
      (g.id === 'r1' ? { ...g, homeGoals: null, awayGoals: null } : g)) };
    expect(codes(open)).toContain('PLAYOFF_SEEDS_PROVISIONAL');
    expect(codes(s0)).not.toContain('PLAYOFF_SEEDS_PROVISIONAL');
  });

  it('refuses a bracket in a league that does not run playoffs', () => {
    const s = base([...ranked(), ...bracket(4)]);
    const v = validateSeason({ ...s, leagueId: 'middle_school' }, MIDDLE_SCHOOL_LEAGUE);
    expect(v.violations.map((x) => x.code)).toContain('PLAYOFFS_NOT_ALLOWED');
  });
});
