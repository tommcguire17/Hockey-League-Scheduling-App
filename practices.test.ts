import { describe, it, expect } from 'vitest';
import {
  Season, HOUSE_LEAGUE, MIDDLE_SCHOOL_LEAGUE, IceRule,
  applyIceRules, suggestIceRules, validateSeason, weekdayOf,
} from '@league/core';
import { assignPractices, generateSchedule } from '@league/engine';

/**
 * Two divisions, four teams each. 8U practises Wednesday, 10U splits Monday
 * and Wednesday, which is the real House shape in miniature.
 */
const WEEKS = 10;
const slots = () => {
  const out: Record<string, unknown>[] = [];
  // 2026-11-02 is a Monday.
  for (let w = 0; w < WEEKS; w++) {
    const mon = new Date(Date.UTC(2026, 10, 2 + w * 7));
    const iso = (add: number) =>
      new Date(mon.getTime() + add * 86400000).toISOString().slice(0, 10);
    out.push({ id: `mon-${w}`, date: iso(0), start: '17:30', minutes: 60, rink: 'R', use: 'practice' });
    out.push({ id: `wed-a-${w}`, date: iso(2), start: '18:10', minutes: 60, rink: 'R', use: 'practice' });
    // Second sheet: 18:10 and 18:20 on one sheet would genuinely overlap.
    out.push({ id: `wed-b-${w}`, date: iso(2), start: '18:20', minutes: 60, rink: 'R2', use: 'practice' });
    out.push({ id: `sat-${w}`, date: iso(5), start: '07:00', minutes: 60, rink: 'R', use: 'game' });
    out.push({ id: `sun-${w}`, date: iso(6), start: '07:00', minutes: 60, rink: 'R', use: 'game' });
  }
  // Evaluations come first: before the first practice week, which starts
  // Monday 2 November.
  out.push({ id: 'eval-8u', date: '2026-11-01', start: '19:00', minutes: 60, rink: 'R', use: 'evaluation', ownerDivisionId: '8U', ownerPolicy: 'exclusive' });
  out.push({ id: 'eval-10u', date: '2026-11-01', start: '20:10', minutes: 60, rink: 'R', use: 'evaluation', ownerDivisionId: '10U', ownerPolicy: 'exclusive' });
  return out;
};

const base = (patch: Record<string, unknown> = {}) => Season.parse({
  id: 's', name: 'S', leagueId: 'house', startDate: '2026-11-01', endDate: '2027-02-28',
  divisions: [
    { id: '8U', name: '8U', gamesPerTeam: 6, practicesPerTeam: WEEKS, evaluationSessions: 1 },
    { id: '10U', name: '10U', gamesPerTeam: 6, practicesPerTeam: WEEKS, evaluationSessions: 1 },
  ],
  teams: ['8U', '10U'].flatMap((d) => [1, 2, 3, 4].map((i) => ({
    id: `${d}-${i}`, divisionId: d, name: `${d} ${i}`,
  }))),
  slots: slots(),
  ...patch,
});

/** Wednesday 18:10 is 8U's; Monday and Wednesday 18:20 are 10U's. */
const owned = () => {
  const s = base();
  return {
    ...s,
    slots: s.slots.map((x) => (x.use !== 'practice' ? x : {
      ...x,
      ownerDivisionId: x.start === '18:10' ? '8U' : '10U',
      ownerPolicy: 'priority' as const,
    })),
  };
};

describe('assignPractices', () => {
  it('gives every team its target, not one team all of them', () => {
    const { practices, report } = assignPractices(owned(), HOUSE_LEAGUE);
    expect(report.issues).toEqual([]);
    for (const d of report.byDivision) {
      expect(d.min).toBe(WEEKS);
      expect(d.max).toBe(WEEKS);
    }
    const per = new Map<string, number>();
    for (const p of practices) {
      if (p.kind !== 'practice') continue;
      for (const t of p.teamIds) per.set(t, (per.get(t) ?? 0) + 1);
    }
    expect([...per.values()]).toEqual(Array(8).fill(WEEKS));
  });

  it('puts the whole age group on one sheet when that is all it has', () => {
    const { practices } = assignPractices(owned(), HOUSE_LEAGUE);
    const eight = practices.filter((p) => p.divisionId === '8U' && p.kind === 'practice');
    expect(eight).toHaveLength(WEEKS);
    expect(eight.every((p) => p.teamIds.length === 4)).toBe(true);
  });

  it('splits a division across its two nights and keeps each team on one', () => {
    const s = owned();
    const slotById = new Map(s.slots.map((x) => [x.id, x]));
    const { practices } = assignPractices(s, HOUSE_LEAGUE);
    const nights = new Map<string, Set<string>>();
    for (const p of practices.filter((x) => x.divisionId === '10U' && x.kind === 'practice')) {
      const sl = slotById.get(p.slotId)!;
      for (const t of p.teamIds) {
        (nights.get(t) ?? nights.set(t, new Set()).get(t)!).add(`${weekdayOf(sl.date)} ${sl.start}`);
      }
    }
    expect(nights.size).toBe(4);
    // Families plan around one night. Every team keeps the same one all season.
    for (const [, set] of nights) expect(set.size).toBe(1);
    expect(new Set([...nights.values()].map((s2) => [...s2][0])).size).toBe(2);
  });

  it('never books a practice on a day the team plays', () => {
    const s = owned();
    const { games } = generateSchedule(s, HOUSE_LEAGUE, { seed: 5 });
    const withGames = { ...s, games };
    const { practices } = assignPractices(withGames, HOUSE_LEAGUE);
    const slotById = new Map(s.slots.map((x) => [x.id, x]));
    const gameDays = new Map<string, Set<string>>();
    for (const g of games) {
      const d = slotById.get(g.slotId!)!.date;
      for (const t of [g.homeTeamId!, g.awayTeamId!]) {
        (gameDays.get(t) ?? gameDays.set(t, new Set()).get(t)!).add(d);
      }
    }
    for (const p of practices.filter((x) => x.kind === 'practice')) {
      const d = slotById.get(p.slotId)!.date;
      for (const t of p.teamIds) expect(gameDays.get(t)?.has(d) ?? false).toBe(false);
    }
  });

  it('books the evaluation sheets with the whole division on them', () => {
    const { practices, report } = assignPractices(owned(), HOUSE_LEAGUE);
    const evals = practices.filter((p) => p.kind === 'evaluation');
    expect(report.evaluations).toBe(2);
    expect(evals.map((e) => e.divisionId).sort()).toEqual(['10U', '8U']);
    expect(evals.every((e) => e.teamIds.length === 4)).toBe(true);
  });

  it('says which division has no evaluation ice', () => {
    const s = owned();
    const { report } = assignPractices(
      { ...s, slots: s.slots.filter((x) => x.id !== 'eval-8u') }, HOUSE_LEAGUE);
    expect(report.issues.join(' ')).toMatch(/8U needs 1 evaluation session and has none/);
    expect(report.suggestions.some((x) => x.to === 'evaluation')).toBe(true);
  });

  it('asks for a second sheet when a division runs two sessions', () => {
    const s = owned();
    const busy = {
      ...s,
      divisions: s.divisions.map((d) => (d.id === '10U' ? { ...d, evaluationSessions: 2 } : d)),
    };
    const { report } = assignPractices(busy, HOUSE_LEAGUE);
    expect(report.issues.join(' ')).toMatch(/10U needs 2 evaluation sessions but only 1 sheet is/);
  });

  it('says so rather than silently going short when a division has no practice ice', () => {
    const s = base();                         // nothing owned by anyone
    const stripped = {
      ...s, slots: s.slots.map((x) => (x.start === '18:10' ? { ...x, use: 'unused' as const } : x)),
    };
    const { report } = assignPractices(stripped, HOUSE_LEAGUE);
    expect(report.issues.length).toBeGreaterThan(0);
  });

  it('leaves a clean validator behind', () => {
    const s = owned();
    const { games } = generateSchedule(s, HOUSE_LEAGUE, { seed: 11 });
    const { practices } = assignPractices({ ...s, games }, HOUSE_LEAGUE);
    const v = validateSeason({ ...s, games, practices }, HOUSE_LEAGUE);
    expect(v.violations.filter((x) => x.severity === 'error')).toEqual([]);
  });

  it('does nothing in a league that has no practices', () => {
    const { practices, report } = assignPractices(
      { ...owned(), leagueId: 'middle_school' }, MIDDLE_SCHOOL_LEAGUE);
    expect(practices).toEqual([]);
    expect(report.issues[0]).toMatch(/no practices/);
  });
});

describe('reserved ice', () => {
  const reserve = (policy: 'priority' | 'exclusive') => {
    const s = owned();
    return {
      ...s,
      slots: s.slots.map((x) =>
        (x.use === 'game' && x.start === '07:00' && weekdayOf(x.date) === 'sunday'
          ? { ...x, ownerDivisionId: '8U', ownerPolicy: policy } : x)),
    };
  };

  it('gives the owner its own ice first', () => {
    const s = reserve('priority');
    const { games, report } = generateSchedule(s, HOUSE_LEAGUE, { seed: 3 });
    const slotById = new Map(s.slots.map((x) => [x.id, x]));
    const sunday = games.filter((g) => {
      const sl = slotById.get(g.slotId!);
      return sl && sl.start === '07:00' && weekdayOf(sl.date) === 'sunday';
    });
    expect(sunday.length).toBeGreaterThan(0);
    expect(report.ownerFirst).toBeGreaterThan(0);
    // The owner takes them before anyone else gets a look in.
    const eight = sunday.filter((g) => g.divisionId === '8U').length;
    expect(eight).toBeGreaterThanOrEqual(sunday.length - report.ownerReleased);
  });

  it('releases reserved ice once the owner has its games', () => {
    // 8U needs 12 games and there are 10 Sunday slots, so nothing releases...
    const tight = reserve('priority');
    const loose = {
      ...tight,
      divisions: tight.divisions.map((d) => (d.id === '8U' ? { ...d, gamesPerTeam: 2 } : d)),
    };
    const r = generateSchedule(loose, HOUSE_LEAGUE, { seed: 3 });
    // ...but with 8U needing only a handful, the rest of the Sundays open up.
    expect(r.report.ownerReleased).toBeGreaterThan(0);
    expect(r.report.unplaced).toEqual([]);
  });

  it('never releases exclusive ice, even when the owner is finished', () => {
    const s = reserve('exclusive');
    const small = {
      ...s, divisions: s.divisions.map((d) => (d.id === '8U' ? { ...d, gamesPerTeam: 2 } : d)),
    };
    const { games } = generateSchedule(small, HOUSE_LEAGUE, { seed: 3 });
    const slotById = new Map(s.slots.map((x) => [x.id, x]));
    for (const g of games) {
      const sl = slotById.get(g.slotId!);
      if (sl?.ownerDivisionId === '8U') expect(g.divisionId).toBe('8U');
    }
  });

  it('runs two games at once on a cross-ice sheet', () => {
    const s = owned();
    const cross = {
      ...s,
      slots: s.slots.map((x) => (x.use === 'game' ? { ...x, capacity: 2 } : x)),
    };
    const { games } = generateSchedule(cross, HOUSE_LEAGUE, { seed: 7 });
    const perSlot = new Map<string, number>();
    for (const g of games) perSlot.set(g.slotId!, (perSlot.get(g.slotId!) ?? 0) + 1);
    expect(Math.max(...perSlot.values())).toBe(2);
    const v = validateSeason({ ...cross, games }, HOUSE_LEAGUE);
    expect(v.violations.filter((x) => x.severity === 'error')).toEqual([]);
  });
});

describe('ice rules', () => {
  it('finds the weekly patterns in the booked ice', () => {
    const found = suggestIceRules(base());
    const keys = found.map((r) => `${r.weekdays[0]} ${r.start} ${r.matchUse}`);
    expect(keys).toContain('monday 17:30 practice');
    expect(keys).toContain('wednesday 18:10 practice');
    expect(keys).toContain('sunday 07:00 game');
    // Two one-off evaluation slots are not a weekly pattern.
    expect(keys.some((k) => k.includes('evaluation'))).toBe(false);
  });

  it('stamps a division onto every slot the rule matches', () => {
    const s = base();
    const rules = [IceRule.parse({
      id: 'r1', weekdays: ['wednesday'], start: '18:10', matchUse: 'practice',
      setUse: 'practice', divisionId: '8U', policy: 'priority',
    })];
    const { season: next, applied } = applyIceRules({ ...s, iceRules: rules });
    expect(applied[0]!.matched).toBe(WEEKS);
    const touched = next.slots.filter(
      (x) => x.ownerDivisionId === '8U' && x.use === 'practice');
    expect(touched).toHaveLength(WEEKS);
    expect(touched.every((x) => x.start === '18:10')).toBe(true);
  });

  it('returns the same season when the rules change nothing', () => {
    const s = base();
    const once = applyIceRules({ ...s, iceRules: suggestIceRules(s) }).season;
    expect(applyIceRules(once).season).toBe(once);
  });

  it('lets a later rule override an earlier one', () => {
    const s = base();
    const rules = [
      IceRule.parse({ id: 'broad', weekdays: ['wednesday'], divisionId: '8U' }),
      IceRule.parse({ id: 'narrow', weekdays: ['wednesday'], start: '18:20', divisionId: '10U' }),
    ];
    const { season: next } = applyIceRules({ ...s, iceRules: rules });
    const at = (start: string) => next.slots.find((x) => x.start === start
      && weekdayOf(x.date) === 'wednesday')!;
    expect(at('18:10').ownerDivisionId).toBe('8U');
    expect(at('18:20').ownerDivisionId).toBe('10U');
  });

  it('sets cross-ice capacity and practice sharing from the rule', () => {
    const s = base();
    const rules = [IceRule.parse({
      id: 'x', weekdays: ['sunday'], start: '07:00', divisionId: '8U',
      capacity: 2, practiceTeams: 0,
    })];
    const { season: next } = applyIceRules({ ...s, iceRules: rules });
    expect(next.slots.filter((x) => x.capacity === 2)).toHaveLength(WEEKS);
  });
});
