import { describe, it, expect } from 'vitest';
import { Season, HOUSE_LEAGUE, slotHolds, validateSeason, GAMES_PER_SHEET } from '@league/core';
import { generateSchedule } from '@league/engine';

const season = (fmtA: string, fmtB: string, slots = 16, teams = 4, games = 4) => Season.parse({
  id: 't', name: 't', leagueId: 'house', startDate: '2027-01-01', endDate: '2027-06-30',
  divisions: [
    { id: 'A', name: 'A', gamesPerTeam: games, practicesPerTeam: 0, iceFormat: fmtA },
    { id: 'B', name: 'B', gamesPerTeam: games, practicesPerTeam: 0, iceFormat: fmtB },
  ],
  teams: ['A', 'B'].flatMap((d) => Array.from({ length: teams }, (_, i) => ({
    id: `${d}-${i + 1}`, divisionId: d, name: `${d} ${i + 1}`,
  }))),
  slots: Array.from({ length: slots }, (_, i) => ({
    id: `s${i}`,
    date: `2027-0${1 + Math.floor(i / 4)}-${String((i % 4) * 7 + 1).padStart(2, '0')}`,
    start: '08:00', minutes: 60, rink: 'R', use: 'game',
  })),
});

const sheets = (games: { slotId: string | null; divisionId: string }[]) => {
  const m = new Map<string, string[]>();
  for (const g of games) {
    if (!g.slotId) continue;
    (m.get(g.slotId) ?? m.set(g.slotId, []).get(g.slotId)!).push(g.divisionId);
  }
  return m;
};

describe('how a division splits a sheet', () => {
  it('turns a format into a number of games', () => {
    expect(GAMES_PER_SHEET).toEqual({ full: 1, half: 2, cross: 3 });
  });

  it('takes the number from the division, not the slot', () => {
    const s = season('cross', 'full');
    const slot = s.slots[0]!;
    expect(slotHolds(slot, s.divisions[0])).toBe(3);
    expect(slotHolds(slot, s.divisions[1])).toBe(1);
  });

  it('still lets one odd booking override', () => {
    const s = season('cross', 'full');
    expect(slotHolds({ ...s.slots[0]!, capacity: 1 }, s.divisions[0])).toBe(1);
  });

  it('never puts two divisions on one sheet', () => {
    // Every combination, including two that split the ice the same way.
    for (const [a, b] of [['full', 'full'], ['cross', 'full'], ['half', 'half'], ['cross', 'cross']]) {
      const s = season(a!, b!);
      const { games } = generateSchedule(s, HOUSE_LEAGUE, { seed: 3 });
      for (const [, divs] of sheets(games)) expect(new Set(divs).size).toBe(1);
      expect(validateSeason({ ...s, games }, HOUSE_LEAGUE).violations
        .filter((v) => v.code === 'SLOT_SPLIT_BETWEEN_DIVISIONS')).toEqual([]);
    }
  });

  it('never puts more games on a sheet than the format allows', () => {
    for (const [a, b] of [['full', 'full'], ['cross', 'full'], ['half', 'cross']]) {
      const s = season(a!, b!, 8, 6, 6);
      const { games } = generateSchedule(s, HOUSE_LEAGUE, { seed: 5 });
      for (const [slotId, divs] of sheets(games)) {
        const slot = s.slots.find((x) => x.id === slotId)!;
        const div = s.divisions.find((d) => d.id === divs[0])!;
        expect(divs.length).toBeLessThanOrEqual(slotHolds(slot, div));
      }
    }
  });

  it('packs three cross-ice games onto a sheet when the ice is tight', () => {
    const s = Season.parse({
      id: 't', name: 't', leagueId: 'house', startDate: '2027-01-01', endDate: '2027-03-31',
      divisions: [{ id: 'A', name: 'A', gamesPerTeam: 6, practicesPerTeam: 0, iceFormat: 'cross' }],
      teams: [1, 2, 3, 4, 5, 6].map((i) => ({ id: `A-${i}`, divisionId: 'A', name: `A ${i}` })),
      slots: [0, 1, 2, 3, 4, 5].map((i) => ({
        id: `s${i}`, date: `2027-01-${String(i * 7 + 4).padStart(2, '0')}`,
        start: '08:00', minutes: 60, rink: 'R', use: 'game',
      })),
    });
    const { games } = generateSchedule(s, HOUSE_LEAGUE, { seed: 5 });
    expect(Math.max(...[...sheets(games).values()].map((v) => v.length))).toBe(3);
  });

  it('leaves a full-ice division one game to a sheet however much ice there is', () => {
    const s = season('full', 'full', 24, 4, 6);
    const { games } = generateSchedule(s, HOUSE_LEAGUE, { seed: 7 });
    expect(Math.max(...[...sheets(games).values()].map((v) => v.length))).toBe(1);
  });

  it('counts a game it is not allowed to move as being on the sheet', () => {
    // A bracket, away or locked game holds its sheet for its own division.
    // It is not part of the search, so checking only the search's own
    // placements left the other half of a split sheet open to anybody.
    const s = season('half', 'half', 10, 4, 4);
    const held = Season.parse({
      ...s,
      games: [{
        id: 'po-A-f', divisionId: 'A', slotId: 's0', type: 'final',
        homeTeamId: 'A-1', awayTeamId: 'A-2', locked: true,
      }],
    });
    const { games } = generateSchedule(held, HOUSE_LEAGUE, { seed: 9 });
    const onS0 = games.filter((g) => g.slotId === 's0');
    expect(new Set(onS0.map((g) => g.divisionId))).toEqual(new Set(['A']));
    expect(onS0.length).toBeLessThanOrEqual(2);
  });

  it('calls out a sheet split between divisions', () => {
    const s = season('half', 'half');
    const bad = {
      ...s,
      games: [
        { id: 'g1', divisionId: 'A', slotId: 's0', homeTeamId: 'A-1', awayTeamId: 'A-2' },
        { id: 'g2', divisionId: 'B', slotId: 's0', homeTeamId: 'B-1', awayTeamId: 'B-2' },
      ],
    };
    const codes = validateSeason(Season.parse(bad), HOUSE_LEAGUE).violations.map((v) => v.code);
    expect(codes).toContain('SLOT_SPLIT_BETWEEN_DIVISIONS');
  });

  it('calls out more games than the format allows', () => {
    const s = season('full', 'full');
    const bad = {
      ...s,
      games: [
        { id: 'g1', divisionId: 'A', slotId: 's0', homeTeamId: 'A-1', awayTeamId: 'A-2' },
        { id: 'g2', divisionId: 'A', slotId: 's0', homeTeamId: 'A-3', awayTeamId: 'A-4' },
      ],
    };
    const v = validateSeason(Season.parse(bad), HOUSE_LEAGUE);
    const hit = v.violations.find((x) => x.code === 'SLOT_OVERBOOKED')!;
    expect(hit).toBeTruthy();
    expect(hit.message).toMatch(/holds 1 \(full ice\)/);
  });
});
