import { describe, it, expect } from 'vitest';
import { Season, standings, resultProgress, HOUSE_LEAGUE } from '@league/core';

const season = (games: unknown[]) => Season.parse({
  id: 's', name: 'S', leagueId: 'house', startDate: '2027-01-01', endDate: '2027-03-01',
  divisions: [{ id: 'D', name: 'D', gamesPerTeam: 3, practicesPerTeam: 0 }],
  teams: ['A', 'B', 'C', 'D'].map((n) => ({ id: n, divisionId: 'D', name: n })),
  slots: [1, 2, 3, 4, 5, 6].map((i) => ({
    id: `s${i}`, date: `2027-01-0${i}`, start: '12:00', minutes: 60, rink: 'R', use: 'game',
  })),
  games,
});
const g = (id: string, slot: string, h: string, a: string, hg: number | null, ag: number | null) =>
  ({ id, divisionId: 'D', slotId: slot, homeTeamId: h, awayTeamId: a, homeGoals: hg, awayGoals: ag });

describe('standings', () => {
  it('is empty until scores go in', () => {
    const r = standings(season([g('g1', 's1', 'A', 'B', null, null)]), HOUSE_LEAGUE);
    expect(r.every((x) => x.played === 0)).toBe(true);
    expect(r.map((x) => x.rank).sort()).toEqual([1, 2, 3, 4]);
  });

  it('awards points from the manifest, not a hardcoded 2 and 1', () => {
    const s = season([g('g1', 's1', 'A', 'B', 5, 2), g('g2', 's2', 'C', 'D', 1, 1)]);
    const soccer = { ...HOUSE_LEAGUE, standings: { winPoints: 3, tiePoints: 1, lossPoints: 0 } };
    const r = standings(s, soccer);
    expect(r.find((x) => x.teamId === 'A')!.points).toBe(3);
    expect(r.find((x) => x.teamId === 'C')!.points).toBe(1);
  });

  it('counts a 0-0 draw as played', () => {
    const r = standings(season([g('g1', 's1', 'A', 'B', 0, 0)]), HOUSE_LEAGUE);
    expect(r.find((x) => x.teamId === 'A')!.played).toBe(1);
    expect(r.find((x) => x.teamId === 'A')!.tied).toBe(1);
  });

  it('tracks goals, difference and form', () => {
    const s = season([
      g('g1', 's1', 'A', 'B', 5, 2),
      g('g2', 's2', 'A', 'C', 1, 4),
      g('g3', 's3', 'A', 'D', 3, 3),
    ]);
    const a = standings(s, HOUSE_LEAGUE).find((x) => x.teamId === 'A')!;
    expect([a.played, a.won, a.lost, a.tied]).toEqual([3, 1, 1, 1]);
    expect([a.goalsFor, a.goalsAgainst, a.diff]).toEqual([9, 9, 0]);
    expect(a.points).toBe(3);                    // 2 for the win, 1 for the tie
    expect(a.form).toEqual(['T', 'L', 'W']);     // newest first
  });

  it('breaks a tie on goal difference, then goals for', () => {
    const s = season([
      g('g1', 's1', 'A', 'B', 5, 0),   // A +5
      g('g2', 's2', 'C', 'D', 2, 0),   // C +2
      g('g3', 's3', 'B', 'D', 9, 1),   // B +8, same points as C
    ]);
    const r = standings(s, HOUSE_LEAGUE).filter((x) => x.divisionId === 'D');
    expect(r.map((x) => x.teamId)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('ignores playoff games', () => {
    const s = season([
      g('g1', 's1', 'A', 'B', 1, 0),
      { ...g('g2', 's2', 'A', 'B', 9, 0), type: 'final' },
    ]);
    expect(standings(s, HOUSE_LEAGUE).find((x) => x.teamId === 'A')!.goalsFor).toBe(1);
  });

  it('counts an away game the same as a home one', () => {
    const s = Season.parse({
      id: 's', name: 'S', leagueId: 'house', startDate: '2027-01-01', endDate: '2027-03-01',
      divisions: [{ id: 'D', name: 'D', gamesPerTeam: 1, practicesPerTeam: 0 }],
      teams: ['A', 'B'].map((n) => ({ id: n, divisionId: 'D', name: n })),
      slots: [],
      games: [{ id: 'g1', divisionId: 'D', homeTeamId: 'A', awayTeamId: 'B',
                homeGoals: 4, awayGoals: 1,
                away: { facility: 'Codey', city: '', date: '2027-01-09', start: '18:00', minutes: 60 } }],
    });
    expect(standings(s, HOUSE_LEAGUE).find((x) => x.teamId === 'A')!.won).toBe(1);
  });

  it('reports how much of the season has a result', () => {
    const s = season([g('g1', 's1', 'A', 'B', 1, 0), g('g2', 's2', 'C', 'D', null, null)]);
    expect(resultProgress(s)).toEqual({ played: 1, total: 2 });
  });
});
