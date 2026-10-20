import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  Season, HOUSE_LEAGUE, MIDDLE_SCHOOL_LEAGUE, PLAYOFF_TYPES, manifestFor, weekKey,
  validateSeason, weekdayOf,
} from '@league/core';
import { generateSchedule, generatePlayoffs, planPlayoffIce } from '@league/engine';

/**
 * The bug these tests exist for: a regular season that runs to the last night
 * of booked ice leaves the brackets nowhere to play, and the generator used to
 * do exactly that and call it a success. The reservation has to hold the tail
 * back — and, just as importantly, has to yield rather than starving the
 * regular season when the ice is genuinely short.
 */

/** Tom's own House season: the one the bug was found on. */
const real = Season.parse(JSON.parse(
  readFileSync(new URL('../../../data/msu-2026-27.season.json', import.meta.url), 'utf8')));

/** Weekend game ice every Saturday and Sunday, two sheets a day. */
function weekendSeason(opts: {
  weeks?: number; teams?: number; gamesPerTeam?: number;
  playoffTeams?: number; sheets?: number;
} = {}) {
  const weeks = opts.weeks ?? 20;
  const sheets = opts.sheets ?? 2;
  const names = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].slice(0, opts.teams ?? 4);

  const slots: unknown[] = [];
  const first = Date.UTC(2026, 11, 5);                     // Saturday 5 Dec 2026
  for (let w = 0; w < weeks; w++) {
    for (const dow of [0, 1]) {
      const d = new Date(first + (w * 7 + dow) * 86400000).toISOString().slice(0, 10);
      for (let k = 0; k < sheets; k++) {
        slots.push({
          id: `w${w}d${dow}s${k}`, date: d, start: k ? '14:00' : '12:00',
          minutes: 60, rink: 'Red Hawk', use: 'game',
        });
      }
    }
  }
  const last = new Date(first + ((weeks - 1) * 7 + 1) * 86400000).toISOString().slice(0, 10);

  return Season.parse({
    id: 's', name: 'S', leagueId: 'house',
    startDate: '2026-12-05', endDate: last,
    divisions: [{
      id: 'U10', name: '10U', gamesPerTeam: opts.gamesPerTeam ?? 12,
      practicesPerTeam: 0, playoffTeams: opts.playoffTeams ?? 4,
    }],
    teams: names.map((n) => ({ id: n, divisionId: 'U10', name: `Team ${n}` })),
    slots, games: [], practices: [],
  });
}

const dateOf = (s: Season) => new Map(s.slots.map((x) => [x.id, x.date]));

/** When the regular season ends, and whether every bracket game found ice. */
function play(s: Season, m = HOUSE_LEAGUE) {
  const r = generateSchedule(s, m, { seed: 11 });
  const d = dateOf(s);
  const regular = r.games.filter((g) => g.type === 'regular')
    .map((g) => d.get(g.slotId!)!).sort();
  const p = generatePlayoffs({ ...s, games: r.games }, m);
  return {
    report: r.report,
    regularEnds: regular.at(-1)!,
    unplaced: r.report.unplaced.length,
    placed: p.report.placed,
    needed: p.report.needed,
    finalsOn: p.report.finalsOn,
  };
}

describe('planPlayoffIce', () => {
  it('holds back the last nights of game ice', () => {
    const plan = planPlayoffIce(weekendSeason(), HOUSE_LEAGUE);
    // Two semifinals and a final. No third-place game unless the season says
    // so, which is the default and what the house league actually plays.
    expect(plan.games).toBe(3);
    expect(plan.dates.length).toBeGreaterThan(0);
    expect(plan.sufficient).toBe(true);
    // The window is at the END of the season, which is the whole point.
    const s = weekendSeason();
    const lastNight = [...new Set(s.slots.map((x) => x.date))].sort().at(-1);
    expect(plan.dates.at(-1)).toBe(lastNight);
  });

  it('holds back no more than the brackets need, plus a night of slack', () => {
    const plan = planPlayoffIce(weekendSeason(), HOUSE_LEAGUE);
    // Two rounds, two sheets a night: two nights hold the bracket. The third
    // is margin, because a window with nothing spare loses a semifinal to the
    // first regular-season game that spills into it — and the regular season
    // takes the slack back the moment it cannot fit without it.
    expect(plan.rounds).toBe(2);
    expect(plan.dates.length).toBe(3);
  });

  it('plays a third-place game when the season asks for one', () => {
    const plan = planPlayoffIce(
      { ...weekendSeason(), playoffConsolation: true }, HOUSE_LEAGUE);
    expect(plan.games).toBe(4);
  });

  it('reserves nothing for a league that runs no playoffs', () => {
    const s = { ...weekendSeason(), leagueId: 'middle_school' as const };
    const plan = planPlayoffIce(Season.parse(s), MIDDLE_SCHOOL_LEAGUE);
    expect(plan.games).toBe(0);
    expect(plan.dates).toEqual([]);
    expect(plan.sufficient).toBe(true);
  });

  it('reserves nothing for a division with no bracket', () => {
    const plan = planPlayoffIce(weekendSeason({ playoffTeams: 0 }), HOUSE_LEAGUE);
    expect(plan.dates).toEqual([]);
  });

  it('says so when a bracket shape is impossible rather than silently skipping it', () => {
    const plan = planPlayoffIce(weekendSeason({ playoffTeams: 5 }), HOUSE_LEAGUE);
    expect(plan.games).toBe(0);
    expect(plan.byDivision[0]!.skip).toMatch(/not a bracket shape/);
  });
});

describe('generateSchedule, playoff window', () => {
  it('finishes the regular season before the playoff window', () => {
    const r = play(weekendSeason());
    expect(r.unplaced).toBe(0);
    expect(r.report.playoffIce.dates.length).toBeGreaterThan(0);
    expect(r.regularEnds < r.report.playoffIce.dates[0]!).toBe(true);
  });

  it('leaves the brackets ice — the whole bug', () => {
    const r = play(weekendSeason());
    // Two semifinals and a final; no third-place game by default.
    expect(r.needed).toBe(3);
    expect(r.placed).toBe(3);
    expect(r.report.playoffIce.sufficient).toBe(true);
    expect(r.report.playoffIce.taken).toBe(0);
  });

  it('plays the final after the regular season, not during it', () => {
    // Not necessarily on the very last night: with ice to spare the allocator
    // keeps the bracket compact, which is right. What must hold is that the
    // final is the last thing the division plays.
    const r = play(weekendSeason());
    expect(r.placed).toBe(r.needed);
    expect(r.finalsOn! > r.regularEnds).toBe(true);
  });

  it('compacts the regular season rather than dropping a game', () => {
    // Just enough ice that the season only fits once the window is held back:
    // the games have to double up, which is exactly what Tom asked for.
    const r = play(weekendSeason({ weeks: 7, gamesPerTeam: 12 }));
    expect(r.unplaced).toBe(0);
    expect(r.placed).toBe(r.needed);
    expect(r.report.busyWeeks.total).toBeGreaterThan(0);
  });

  it('puts the doubled-up weekends late, where a double means catching up', () => {
    // Only testable on a season with slack. A season whose ice is saturated
    // has no choice to make — 64 games over 13 weekends for 8 teams forces
    // exactly two doubles every single week, early and late alike — so the
    // preference can only show up where the generator could have done
    // otherwise. The real House season is that case.
    const r = generateSchedule({ ...real, games: [] }, manifestFor(real.leagueId), { seed: 11 });
    const months = Object.keys(r.report.busyWeeks.byMonth).sort();
    expect(r.report.busyWeeks.total).toBeGreaterThan(0);
    expect(months.length).toBeGreaterThan(1);
    const first = r.report.busyWeeks.byMonth[months[0]!] ?? 0;
    const last = r.report.busyWeeks.byMonth[months.at(-1)!] ?? 0;
    expect(last).toBeGreaterThan(first);
  });

  it('yields the window rather than stranding a regular-season game', () => {
    // Twenty-four games into twenty-four openings: the regular season needs
    // every sheet there is, playoff window included. It must still be
    // complete, and the shortfall must be reported rather than paid for with
    // a deleted fixture.
    const r = play(weekendSeason({ weeks: 6, gamesPerTeam: 12 }));
    expect(r.unplaced).toBe(0);
    expect(r.report.playoffIce.taken).toBeGreaterThan(0);
    expect(r.report.playoffIce.sufficient).toBe(false);
    expect(r.report.playoffIce.issues.join(' ')).toMatch(/nowhere to play/);
  });

  it('names ice to flip when the brackets come up short', () => {
    const s = weekendSeason({ weeks: 6, gamesPerTeam: 12 });
    // Give it some practice ice on a weekend night to propose.
    const extra = Season.parse({
      ...s,
      slots: [...s.slots, {
        id: 'prac1', date: s.slots.at(-1)!.date, start: '16:00',
        minutes: 60, rink: 'Rocky', use: 'practice',
      }],
    });
    const r = generateSchedule(extra, HOUSE_LEAGUE, { seed: 11 });
    expect(r.report.suggestions.some((x) => x.slotId === 'prac1' && x.to === 'game')).toBe(true);
  });

  it('is stable: regenerating gives the same window and the same end date', () => {
    const s = weekendSeason({ weeks: 12, gamesPerTeam: 14 });
    const a = play(s);
    const b = play({ ...s, games: [] });
    expect(b.report.playoffIce.dates).toEqual(a.report.playoffIce.dates);
    expect(b.regularEnds).toBe(a.regularEnds);
  });

  it('never reserves a night the league does not play on', () => {
    const plan = planPlayoffIce(weekendSeason(), HOUSE_LEAGUE);
    for (const d of plan.dates) {
      expect(HOUSE_LEAGUE.scheduling.blockedWeekdays).not.toContain(weekdayOf(d));
    }
  });
});

describe("Tom's House season", () => {
  const m = manifestFor(real.leagueId);

  it('no longer leaves the playoffs out entirely', () => {
    const r = play({ ...real, games: [] }, m);
    // Before the reservation this was 0 of 16: the regular season ran to
    // 21 March and the brackets had nowhere to go.
    expect(r.placed).toBeGreaterThan(0);
    expect(r.report.playoffIce.dates.length).toBeGreaterThan(0);
  });

  it('states the shortage as arithmetic instead of hiding it', () => {
    const r = play({ ...real, games: [] }, m);
    expect(r.report.playoffIce.sufficient).toBe(false);
    expect(r.report.playoffIce.issues.join(' ')).toMatch(/game opening/);
    expect(r.report.suggestions.length).toBeGreaterThan(0);
  });

  it('fits the whole season, playoffs included, at 14 games per team', () => {
    // Measured, not assumed: 16 games a team places 7 of 16 bracket games,
    // 15 places 13, and 14 places all of them with the ice already booked.
    const trimmed = Season.parse({
      ...real,
      divisions: real.divisions.map((d) =>
        (d.id === '8U' ? d : { ...d, gamesPerTeam: 14 })),
      games: [],
    });
    const r = play(trimmed, m);
    expect(r.unplaced).toBe(0);
    expect(r.placed).toBe(r.needed);
    expect(r.report.playoffIce.sufficient).toBe(true);
  });

  it('keeps a bracket already built through a regenerate', () => {
    const first = generateSchedule({ ...real, games: [] }, m, { seed: 11 });
    const withPo = generatePlayoffs({ ...real, games: first.games }, m);
    const po = withPo.games.filter((g) => PLAYOFF_TYPES.has(g.type) && g.slotId);
    expect(po.length).toBeGreaterThan(0);
    const again = generateSchedule({ ...real, games: withPo.games }, m, { seed: 11 });
    const kept = again.games.filter((g) => PLAYOFF_TYPES.has(g.type) && g.slotId);
    expect(kept.length).toBe(po.length);
  });
});

describe('ice marked as the playoffs own', () => {
  /** Mark every game sheet on or after `from` as playoff ice. */
  const mark = (s: Season, from: string): Season => ({
    ...s,
    slots: s.slots.map((x) =>
      (x.use === 'game' && x.date >= from ? { ...x, use: 'playoff' as const } : x)),
  });

  it('is the window, with nothing left to infer', () => {
    const s = weekendSeason({ weeks: 20 });
    const nights = [...new Set(s.slots.map((x) => x.date))].sort();
    const from = nights.at(-4)!;
    const plan = planPlayoffIce(mark(s, from), HOUSE_LEAGUE);
    expect(plan.dates).toEqual(nights.slice(-4));
    expect(plan.sufficient).toBe(true);
  });

  it('keeps the regular season off it entirely', () => {
    const s = weekendSeason({ weeks: 20 });
    const from = [...new Set(s.slots.map((x) => x.date))].sort().at(-4)!;
    const marked = mark(s, from);
    const r = generateSchedule(marked, HOUSE_LEAGUE, { seed: 11 });
    const date = dateOf(marked);
    const regular = r.games.filter((g) => g.type === 'regular' && g.slotId);
    expect(regular.length).toBeGreaterThan(0);
    for (const g of regular) expect(date.get(g.slotId!)! < from).toBe(true);
  });

  it('gives the brackets that ice', () => {
    const s = weekendSeason({ weeks: 20 });
    const from = [...new Set(s.slots.map((x) => x.date))].sort().at(-4)!;
    const marked = mark(s, from);
    const r = generateSchedule(marked, HOUSE_LEAGUE, { seed: 11 });
    const p = generatePlayoffs({ ...marked, games: r.games }, HOUSE_LEAGUE);
    expect(p.report.placed).toBe(p.report.needed);
    const date = dateOf(marked);
    for (const g of p.games.filter((x) => PLAYOFF_TYPES.has(x.type) && x.slotId)) {
      expect(date.get(g.slotId!)! >= from).toBe(true);
    }
  });

  it('forces the squeeze: the same games into fewer weekends', () => {
    // The point of marking. Cutting four weekends off the regular season has
    // to come out somewhere, and where it comes out is doubled-up weekends.
    const s = weekendSeason({ weeks: 16, teams: 6, gamesPerTeam: 15, sheets: 2 });
    const loose = generateSchedule(s, HOUSE_LEAGUE, { seed: 11 });
    const from = [...new Set(s.slots.map((x) => x.date))].sort().at(-6)!;
    const tight = generateSchedule(mark(s, from), HOUSE_LEAGUE, { seed: 11 });
    expect(tight.report.busyWeeks.total)
      .toBeGreaterThan(loose.report.busyWeeks.total);
  });

  it('says marked ice is the reason when a game then has nowhere to go', () => {
    // Mark so much that the season genuinely cannot fit. The fixture must not
    // vanish quietly, and the reason must point at the decision that caused
    // it rather than at the weekly rule.
    const s = weekendSeason({ weeks: 10, gamesPerTeam: 16 });
    const from = [...new Set(s.slots.map((x) => x.date))].sort()[6]!;
    const r = generateSchedule(mark(s, from), HOUSE_LEAGUE, { seed: 11 });
    expect(r.report.unplaced.length).toBeGreaterThan(0);
    expect(r.report.unplaced[0]!.reason).toMatch(/playoff ice you marked/);
  });

  it('is never quietly used for a regular-season game', () => {
    const s = weekendSeason({ weeks: 20 });
    const from = [...new Set(s.slots.map((x) => x.date))].sort().at(-4)!;
    const marked = mark(s, from);
    const slot = marked.slots.find((x) => x.use === 'playoff')!;
    const broken = Season.parse({
      ...marked,
      games: [{
        id: 'x', divisionId: 'U10', slotId: slot.id,
        homeTeamId: 'A', awayTeamId: 'B', type: 'regular',
      }],
    });
    const codes = validateSeason(broken, HOUSE_LEAGUE).violations.map((v) => v.code);
    expect(codes).toContain('REGULAR_ON_PLAYOFF_ICE');
  });
});
