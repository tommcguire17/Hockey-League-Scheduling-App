import { describe, it, expect } from 'vitest';
import {
  Season, HOUSE_LEAGUE, MIDDLE_SCHOOL_LEAGUE, daysBetween, gameWhen, weekKey,
  type LeagueManifest,
} from '@league/core';
import { generateSchedule } from '@league/engine';

/**
 * Weekend ice across `weeks` weeks, `perWeekend` sheets each. Shrinking
 * `perWeekend` is how these tests make ice scarce enough to force a choice
 * between a second game in a week and a game that never gets played.
 */
const season = (weeks: number, perWeekend: number, gamesPerTeam = 10) => {
  const slots: Record<string, unknown>[] = [];
  for (let w = 0; w < weeks; w++) {
    for (let i = 0; i < perWeekend; i++) {
      const sat = new Date(Date.UTC(2026, 10, 7 + w * 7 + (i % 2)));
      slots.push({
        id: `s${w}-${i}`, date: sat.toISOString().slice(0, 10),
        start: `${String(8 + Math.floor(i / 2) * 2).padStart(2, '0')}:00`,
        minutes: 60, rink: 'R', use: 'game',
      });
    }
  }
  const last = slots.map((x) => x.date as string).sort().at(-1)!;
  return Season.parse({
    // The season ends when the ice does, so "late in the season" means
    // something: a window padded with months of nothing flattens it.
    id: 's', name: 'S', leagueId: 'house', startDate: '2026-11-01', endDate: last,
    divisions: [{ id: 'A', name: 'A', gamesPerTeam, practicesPerTeam: 0 }],
    teams: [1, 2, 3, 4].map((i) => ({ id: `A-${i}`, divisionId: 'A', name: `A ${i}` })),
    slots,
  });
};

const soft = (sgw: number, mgw: number, over: Partial<LeagueManifest['scheduling']> = {}) => ({
  ...HOUSE_LEAGUE,
  scheduling: {
    ...HOUSE_LEAGUE.scheduling, softGamesPerWeek: sgw, maxGamesPerWeek: mgw, ...over,
  },
});

const weekLoads = (s: Season, games: { slotId: string | null; homeTeamId: string | null; awayTeamId: string | null }[]) => {
  const slot = new Map(s.slots.map((x) => [x.id, x]));
  const per = new Map<string, number>();
  for (const g of games) {
    const w = gameWhen(g as never, slot);
    if (!w) continue;
    for (const t of [g.homeTeamId, g.awayTeamId]) {
      if (!t) continue;
      const k = `${t}|${weekKey(w.date, 'monday')}`;
      per.set(k, (per.get(k) ?? 0) + 1);
    }
  }
  return per;
};

describe('the weekly rule as a soft target', () => {
  it('never breaks the hard ceiling', () => {
    const s = season(8, 4, 12);                       // deliberately tight
    const { games } = generateSchedule(s, soft(1, 2), { seed: 3 });
    expect(Math.max(...weekLoads(s, games).values())).toBeLessThanOrEqual(2);
  });

  it('leaves the soft target alone when there is room', () => {
    const s = season(20, 2, 6);                       // plenty of weekends
    const { games, report } = generateSchedule(s, soft(1, 2), { seed: 3 });
    expect(report.unplaced).toEqual([]);
    expect([...weekLoads(s, games).values()].filter((n) => n > 1)).toEqual([]);
    expect(report.busyWeeks.total).toBe(0);
  });

  it('would rather play twice in a week than not play at all', () => {
    const s = season(7, 4, 12);                       // 24 fixtures, 7 weeks
    const hard = generateSchedule(s, soft(1, 1), { seed: 3 });
    const flex = generateSchedule(s, soft(1, 2), { seed: 3 });
    expect(hard.report.unplaced.length).toBeGreaterThan(0);
    expect(flex.report.unplaced.length).toBeLessThan(hard.report.unplaced.length);
    expect(flex.report.busyWeeks.total).toBeGreaterThan(0);
  });

  it('puts the doubles late rather than early', () => {
    // 28 fixtures over 12 weekends: two a week covers 24, so four weeks have
    // to carry a double. They should be the late ones.
    const s = season(12, 4, 14);
    const { games, report } = generateSchedule(s, soft(1, 2), { seed: 11 });
    expect(report.busyWeeks.total).toBeGreaterThan(0);

    const weeks = [...new Set(s.slots.map((x) => weekKey(x.date, 'monday')))].sort();
    const half = weeks[Math.floor(weeks.length / 2)]!;
    let early = 0, late = 0;
    for (const [k, n] of weekLoads(s, games)) {
      if (n <= 1) continue;
      if (k.split('|')[1]! < half) early++; else late++;
    }
    expect(late).toBeGreaterThan(early);
  });

  it('spreads the doubles rather than loading one unlucky team', () => {
    const s = season(8, 4, 12);
    const { games, report } = generateSchedule(s, soft(1, 2), { seed: 3 });
    const per = new Map<string, number>();
    for (const [k, n] of weekLoads(s, games)) {
      if (n > 1) { const t = k.split('|')[0]!; per.set(t, (per.get(t) ?? 0) + 1); }
    }
    const counts = s.teams.map((t) => per.get(t.id) ?? 0);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(2);
    expect(report.busyWeeks.worstTeam).toBe(Math.max(...counts));
  });

  it('does not answer a loosened week with a pile of back-to-back days', () => {
    const s = season(8, 4, 12);
    const b2b = (games: { slotId: string | null; homeTeamId: string | null; awayTeamId: string | null }[]) => {
      const slot = new Map(s.slots.map((x) => [x.id, x]));
      const dates = new Map<string, string[]>();
      for (const g of games) {
        const w = gameWhen(g as never, slot);
        if (!w) continue;
        for (const t of [g.homeTeamId, g.awayTeamId]) {
          if (t) (dates.get(t) ?? dates.set(t, []).get(t)!).push(w.date);
        }
      }
      let n = 0;
      for (const [, ds] of dates) {
        ds.sort();
        for (let i = 1; i < ds.length; i++) if (daysBetween(ds[i - 1]!, ds[i]!) === 1) n++;
      }
      return n;
    };
    const shaped = generateSchedule(s, soft(1, 2), { seed: 3 });
    const naive = generateSchedule(s, soft(2, 2), { seed: 3 });
    // Both may use two-game weeks; the shaped one should not reach for
    // consecutive days to do it any more often than the naive one.
    expect(b2b(shaped.games)).toBeLessThanOrEqual(b2b(naive.games));
  });

  it('is exactly the old hard rule when the soft target equals the ceiling', () => {
    const s = season(20, 2, 6);
    const { games, report } = generateSchedule(s, soft(1, 1), { seed: 4 });
    expect(Math.max(...weekLoads(s, games).values())).toBe(1);
    expect(report.busyWeeks.total).toBe(0);
  });

  it('leaves leagues that never wanted it untouched', () => {
    expect(MIDDLE_SCHOOL_LEAGUE.scheduling.maxGamesPerWeek).toBe(1);
    expect(MIDDLE_SCHOOL_LEAGUE.scheduling.softGamesPerWeek).toBe(1);
  });

  it('House asks for one a week and allows two', () => {
    expect(HOUSE_LEAGUE.scheduling.softGamesPerWeek).toBe(1);
    expect(HOUSE_LEAGUE.scheduling.maxGamesPerWeek).toBe(2);
  });
});
