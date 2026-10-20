import { describe, it, expect } from 'vitest';
import { Season, HOUSE_LEAGUE, MIDDLE_SCHOOL_LEAGUE, readiness } from '@league/core';

const base = (patch: Record<string, unknown> = {}) => Season.parse({
  id: 's', name: 'S', leagueId: 'house', startDate: '2027-01-01', endDate: '2027-03-01',
  divisions: [{ id: 'A', name: 'A', gamesPerTeam: 2, practicesPerTeam: 0, playoffTeams: 0 }],
  teams: [1, 2].map((i) => ({ id: `A-${i}`, divisionId: 'A', name: `A ${i}` })),
  slots: [1, 2].map((i) => ({
    id: `s${i}`, date: `2027-01-0${i}`, start: '12:00', minutes: 60, rink: 'R', use: 'game',
  })),
  games: [
    { id: 'g1', divisionId: 'A', slotId: 's1', homeTeamId: 'A-1', awayTeamId: 'A-2' },
    { id: 'g2', divisionId: 'A', slotId: 's2', homeTeamId: 'A-2', awayTeamId: 'A-1' },
  ],
  ...patch,
});

describe('readiness', () => {
  it('is 100% when there is nothing left to do', () => {
    const r = readiness(base(), HOUSE_LEAGUE);
    expect(r.ready).toBe(true);
    expect(r.percent).toBe(100);
    expect(r.blockers).toEqual([]);
  });

  it('counts only the conditions that apply, so the denominator maintains itself', () => {
    // No playoffs and no practices here, so neither is counted against it.
    const ids = readiness(base(), HOUSE_LEAGUE).divisions[0]!.criteria.map((c) => c.id);
    expect(ids).toContain('games');
    expect(ids).not.toContain('playoffs');
    expect(ids).not.toContain('practices');
  });

  it('names what is missing instead of a code', () => {
    const s = base({ games: [] });
    const r = readiness(s, HOUSE_LEAGUE);
    expect(r.ready).toBe(false);
    expect(r.blockers.join(' ')).toMatch(/A — Games: 2 teams are short of 2/);
  });

  it('puts an error against the division it belongs to', () => {
    const s = base({
      games: [
        { id: 'g1', divisionId: 'A', slotId: 's1', homeTeamId: 'A-1', awayTeamId: 'A-2' },
        { id: 'g2', divisionId: 'A', slotId: 's1', homeTeamId: 'A-2', awayTeamId: 'A-1' },
      ],
    });
    const r = readiness(s, HOUSE_LEAGUE);
    const clean = r.divisions[0]!.criteria.find((c) => c.id === 'clean')!;
    expect(clean.met).toBe(false);
  });

  it('flags a game with nowhere to play at the season level', () => {
    const s = base({
      games: [{ id: 'g1', divisionId: 'A', slotId: null, homeTeamId: 'A-1', awayTeamId: 'A-2' }],
    });
    const placed = readiness(s, HOUSE_LEAGUE).league.find((c) => c.id === 'placed')!;
    expect(placed.met).toBe(false);
    expect(placed.detail).toMatch(/nowhere to play/);
  });

  it('asks a league without practices or playoffs for neither', () => {
    const ids = readiness({ ...base(), leagueId: 'middle_school' }, MIDDLE_SCHOOL_LEAGUE)
      .divisions[0]!.criteria.map((c) => c.id);
    expect(ids).not.toContain('practices');
    expect(ids).not.toContain('playoffs');
  });

  it('gives a progress fraction for a bar, never above one', () => {
    const r = readiness(base({ games: [] }), HOUSE_LEAGUE);
    for (const c of [...r.league, ...r.divisions.flatMap((d) => d.criteria)]) {
      expect(c.progress).toBeGreaterThanOrEqual(0);
      expect(c.progress).toBeLessThanOrEqual(1);
    }
  });
});
