import { describe, it, expect } from 'vitest';
import {
  Season, validateSeason, summarize, HOUSE_LEAGUE, ADULT_LEAGUE, MIDDLE_SCHOOL_LEAGUE,
  findIceConflicts,
} from '@league/core';

/** Two teams, two slots, one game. The smallest season that validates. */
function tiny(over: Partial<ReturnType<typeof Season.parse>> = {}) {
  return Season.parse({
    id: 's1', name: 'Test', leagueId: 'house',
    startDate: '2026-12-01', endDate: '2027-03-01',
    divisions: [{ id: 'd1', name: 'D1', gamesPerTeam: 1, practicesPerTeam: 0 }],
    teams: [
      { id: 't1', divisionId: 'd1', name: 'T1' },
      { id: 't2', divisionId: 'd1', name: 'T2' },
    ],
    slots: [
      { id: 's-a', date: '2026-12-05', start: '12:00', minutes: 60, rink: 'Rocky', use: 'game' },
      { id: 's-b', date: '2026-12-06', start: '12:00', minutes: 60, rink: 'Rocky', use: 'game' },
    ],
    games: [
      { id: 'g1', divisionId: 'd1', slotId: 's-a', homeTeamId: 't1', awayTeamId: 't2', type: 'regular' },
    ],
    ...over,
  });
}
const codes = (s: ReturnType<typeof Season.parse>, m = HOUSE_LEAGUE) =>
  validateSeason(s, m).violations.map((v) => v.code);

describe('validateSeason', () => {
  it('passes a clean season with no errors', () => {
    const r = validateSeason(tiny(), HOUSE_LEAGUE);
    expect(r.errorCount).toBe(0);
    expect(r.ok).toBe(true);
    expect(r.teams.map((t) => t.games)).toEqual([1, 1]);
  });

  it('enforces conservation: team-games is twice the number of games', () => {
    const r = validateSeason(tiny(), HOUSE_LEAGUE);
    const teamGames = r.teams.reduce((n, t) => n + t.games, 0);
    expect(teamGames).toBe(2);
    expect(codes(tiny())).not.toContain('CONSERVATION_FAILED');
  });

  it('catches a slot booked beyond its capacity', () => {
    const s = tiny();
    s.games.push({ ...s.games[0]!, id: 'g2' });
    expect(codes(s)).toContain('SLOT_OVERBOOKED');
  });

  it('judges a same-day pair by the day it makes, not just that it happened', () => {
    // House allows the weekend double deliberately, so "twice on Sunday" is
    // no longer the question. The question is what the day looks like.
    const pair = (a: string, b: string) => tiny({
      divisions: [{ id: 'd1', name: 'D1', gamesPerTeam: 2, practicesPerTeam: 0, playoffTeams: 0 }],
      slots: [
        { id: 's-a', date: '2026-12-05', start: a, minutes: 60, rink: 'Rocky', use: 'game' },
        { id: 's-b', date: '2026-12-05', start: b, minutes: 60, rink: 'Red Hawk', use: 'game' },
      ],
      games: [
        { id: 'g1', divisionId: 'd1', slotId: 's-a', homeTeamId: 't1', awayTeamId: 't2', type: 'regular' },
        { id: 'g2', divisionId: 'd1', slotId: 's-b', homeTeamId: 't2', awayTeamId: 't1', type: 'regular' },
      ],
    });

    // Noon and two: an hour between the two games. Lunch, then back on.
    expect(codes(pair('12:00', '14:00'))).not.toContain('SAME_DAY_GAP');
    // Off the ice at one, back on at ten past. No break at all.
    expect(codes(pair('12:00', '13:10'))).toContain('SAME_DAY_GAP');
    // Four hours apart: sit in the rink all afternoon, or drive home twice.
    expect(codes(pair('12:00', '17:00'))).toContain('SAME_DAY_GAP');
    // Overlapping is not a long day, it is impossible.
    expect(codes(pair('12:00', '12:30')).join(' ')).toContain('SAME_DAY_GAP');

    // A league that bans the pair outright still says so, and says that.
    const strict = { ...HOUSE_LEAGUE,
      scheduling: { ...HOUSE_LEAGUE.scheduling, allowSameDayDoubleheader: false } };
    expect(codes(pair('12:00', '14:00'), strict)).toContain('SAME_DAY_DOUBLEHEADER');
    expect(codes(pair('12:00', '14:00'), strict)).not.toContain('SAME_DAY_GAP');
  });

  it('calls three games in a day what it is', () => {
    const s = tiny({
      divisions: [{ id: 'd1', name: 'D1', gamesPerTeam: 3, practicesPerTeam: 0, playoffTeams: 0 }],
      slots: [
        { id: 's-a', date: '2026-12-05', start: '12:00', minutes: 60, rink: 'Rocky', use: 'game' },
        { id: 's-b', date: '2026-12-05', start: '14:00', minutes: 60, rink: 'Red Hawk', use: 'game' },
        { id: 's-c', date: '2026-12-05', start: '16:00', minutes: 60, rink: 'Rocky', use: 'game' },
      ],
      games: [
        { id: 'g1', divisionId: 'd1', slotId: 's-a', homeTeamId: 't1', awayTeamId: 't2', type: 'regular' },
        { id: 'g2', divisionId: 'd1', slotId: 's-b', homeTeamId: 't2', awayTeamId: 't1', type: 'regular' },
        { id: 'g3', divisionId: 'd1', slotId: 's-c', homeTeamId: 't1', awayTeamId: 't2', type: 'regular' },
      ],
    });
    expect(codes(s)).toContain('SAME_DAY_DOUBLEHEADER');
  });

  it('catches a game and a practice on the same day', () => {
    const s = tiny();
    s.slots.push({
      id: 's-p', date: '2026-12-05', start: '18:00', minutes: 60, rink: 'Rocky',
      use: 'practice', capacity: 1, practiceTeams: 2, ownerDivisionId: null, tag: '',
    });
    s.practices.push({ id: 'pr1', divisionId: 'd1', slotId: 's-p', teamIds: ['t1'] });
    expect(codes(s)).toContain('GAME_AND_PRACTICE_SAME_DAY');
  });

  it('rejects practices entirely for a league whose manifest has them off', () => {
    const s = tiny();
    s.slots.push({
      id: 's-p', date: '2026-12-20', start: '18:00', minutes: 60, rink: 'Rocky',
      use: 'practice', capacity: 1, practiceTeams: 2, ownerDivisionId: null, tag: '',
    });
    s.practices.push({ id: 'pr1', divisionId: 'd1', slotId: 's-p', teamIds: ['t1'] });
    expect(codes(s, ADULT_LEAGUE)).toContain('PRACTICES_NOT_SUPPORTED');
    expect(codes(s, HOUSE_LEAGUE)).not.toContain('PRACTICES_NOT_SUPPORTED');
  });

  it('blocks Friday and Saturday only for the adult league', () => {
    const s = tiny({
      slots: [{ id: 's-a', date: '2026-12-05', start: '12:00', minutes: 60, rink: 'Rocky', use: 'game' }],
    }); // 2026-12-05 is a Saturday
    expect(codes(s, ADULT_LEAGUE)).toContain('LEAGUE_WEEKDAY_BLOCKED');
    expect(codes(s, HOUSE_LEAGUE)).not.toContain('LEAGUE_WEEKDAY_BLOCKED');
  });

  it('honours a per-team blackout date and weekday restriction', () => {
    const s = tiny();
    s.teams[0]!.blackoutDates = ['2026-12-05'];
    expect(codes(s)).toContain('BLACKOUT_VIOLATED');
    const s2 = tiny();
    s2.teams[0]!.allowedWeekdays = ['tuesday', 'thursday'];
    expect(codes(s2)).toContain('TEAM_WEEKDAY_VIOLATED');
  });

  it('catches playoffs that start before the regular season ends', () => {
    const s = tiny({
      divisions: [{ id: 'd1', name: 'D1', gamesPerTeam: 1, practicesPerTeam: 0, playoffTeams: 2 }],
      slots: [
        { id: 's-a', date: '2027-02-20', start: '12:00', minutes: 60, rink: 'Rocky', use: 'game' },
        { id: 's-b', date: '2027-02-10', start: '12:00', minutes: 60, rink: 'Rocky', use: 'game' },
      ],
      games: [
        { id: 'g1', divisionId: 'd1', slotId: 's-a', homeTeamId: 't1', awayTeamId: 't2', type: 'regular' },
        { id: 'g2', divisionId: 'd1', slotId: 's-b', homeTeamId: 't1', awayTeamId: 't2', type: 'final' },
      ],
    });
    expect(codes(s)).toContain('PLAYOFFS_OVERLAP_REGULAR');
  });

  it('catches a game placed on practice ice, and on ice taken out of play', () => {
    const s = tiny();
    s.slots[0]!.use = 'practice';
    expect(codes(s, ADULT_LEAGUE)).toContain('GAME_ON_PRACTICE_ICE');
    const s2 = tiny();
    s2.slots[0]!.use = 'unused';
    expect(codes(s2)).toContain('GAME_ON_UNUSED_ICE');
  });

  it('catches a game outside the season window', () => {
    const s = tiny();
    s.slots[0]!.date = '2027-06-01';
    expect(codes(s)).toContain('OUTSIDE_SEASON');
  });

  it('reports a run of repeat opponents', () => {
    const slots = [0, 1, 2].map((i) => ({
      id: `s${i}`, date: `2026-12-0${5 + i * 2}`, start: '12:00', minutes: 60,
      rink: 'Rocky', use: 'game' as const,
    }));
    const s = tiny({
      divisions: [{ id: 'd1', name: 'D1', gamesPerTeam: 3, practicesPerTeam: 0, playoffTeams: 0 }],
      slots,
      games: slots.map((sl, i) => ({
        id: `g${i}`, divisionId: 'd1', slotId: sl.id,
        homeTeamId: 't1', awayTeamId: 't2', type: 'regular' as const,
      })),
    });
    const r = validateSeason(s, HOUSE_LEAGUE);
    expect(r.violations.map((v) => v.code)).toContain('REPEAT_OPPONENT_RUN');
    expect(r.teams[0]!.longestRepeatRun).toBe(3);
  });

  it('surfaces unconfirmed middle-school rules as warnings rather than hiding them', () => {
    const s = tiny({ leagueId: 'middle_school' });
    const r = validateSeason(s, MIDDLE_SCHOOL_LEAGUE);
    expect(r.violations.filter((v) => v.code === 'MANIFEST_UNKNOWN').length).toBeGreaterThan(0);
    expect(r.errorCount).toBe(0); // unknowns never block
  });

  it('catches duplicate ids and orphan references', () => {
    const s = tiny();
    s.teams.push({ ...s.teams[0]! });
    expect(codes(s)).toContain('DUPLICATE_ID');
    const s2 = tiny();
    s2.games[0]!.awayTeamId = 'ghost';
    expect(codes(s2)).toContain('GAME_ORPHAN_TEAM');
  });

  it('summarizes violations with errors first', () => {
    const s = tiny();
    s.slots[0]!.use = 'unused';
    const sum = summarize(validateSeason(s, HOUSE_LEAGUE));
    expect(sum[0]!.severity).toBe('error');
  });
});

describe('weekend-only and household rules', () => {
  const weekendOnly = {
    ...MIDDLE_SCHOOL_LEAGUE,
    scheduling: { ...MIDDLE_SCHOOL_LEAGUE.scheduling, defaultGamesPerTeam: 1 },
  };

  it('rejects a weekday game for a weekend-only league', () => {
    // 2027-01-06 is a Wednesday.
    const s = Season.parse({
      id: 'ms', name: 'MS', leagueId: 'middle_school',
      startDate: '2027-01-01', endDate: '2027-03-01',
      divisions: [{ id: 'A', name: 'A', gamesPerTeam: 1 }],
      teams: [{ id: 'A-1', divisionId: 'A', name: 'A1' }, { id: 'A-2', divisionId: 'A', name: 'A2' }],
      slots: [{ id: 'w', date: '2027-01-06', start: '18:00', minutes: 60, rink: 'N', use: 'game' }],
      games: [{ id: 'g', divisionId: 'A', slotId: 'w', homeTeamId: 'A-1', awayTeamId: 'A-2' }],
    });
    const codes = validateSeason(s, weekendOnly).violations.map((v) => v.code);
    expect(codes).toContain('LEAGUE_WEEKDAY_NOT_ALLOWED');
  });

  it('accepts the same fixture on a Saturday', () => {
    const s = Season.parse({
      id: 'ms', name: 'MS', leagueId: 'middle_school',
      startDate: '2027-01-01', endDate: '2027-03-01',
      divisions: [{ id: 'A', name: 'A', gamesPerTeam: 1 }],
      teams: [{ id: 'A-1', divisionId: 'A', name: 'A1' }, { id: 'A-2', divisionId: 'A', name: 'A2' }],
      slots: [{ id: 'w', date: '2027-01-09', start: '18:00', minutes: 60, rink: 'N', use: 'game' }],
      games: [{ id: 'g', divisionId: 'A', slotId: 'w', homeTeamId: 'A-1', awayTeamId: 'A-2' }],
    });
    expect(validateSeason(s, weekendOnly).errorCount).toBe(0);
  });

  it('flags a household dragged to the rink three times in one day', () => {
    const mk = (id: string, teamId: string) => ({
      id, firstName: id, lastName: 'SMITH', divisionId: null, teamId,
      birthDate: null, householdId: 'hh-1', guardianName: '', guardianEmail: 'a@b.c',
      jerseyNumber: null, jerseySize: '', sockSize: '', numberPrefs: [], registeredAt: '',
    });
    const s = Season.parse({
      id: 'h', name: 'H', leagueId: 'house',
      startDate: '2027-01-01', endDate: '2027-03-01',
      divisions: [{ id: 'A', name: 'A', gamesPerTeam: 1, practicesPerTeam: 0 }],
      teams: ['A-1', 'A-2', 'A-3', 'A-4', 'A-5', 'A-6'].map((n) => ({ id: n, divisionId: 'A', name: n })),
      slots: [1, 2, 3].map((i) => ({
        id: `s${i}`, date: '2027-01-09', start: `${8 + i * 2}:00`.padStart(5, '0'),
        minutes: 60, rink: `R${i}`, use: 'game',
      })),
      games: [
        { id: 'g1', divisionId: 'A', slotId: 's1', homeTeamId: 'A-1', awayTeamId: 'A-2' },
        { id: 'g2', divisionId: 'A', slotId: 's2', homeTeamId: 'A-3', awayTeamId: 'A-4' },
        { id: 'g3', divisionId: 'A', slotId: 's3', homeTeamId: 'A-5', awayTeamId: 'A-6' },
      ],
      people: [mk('Ann', 'A-1'), mk('Bob', 'A-3'), mk('Cal', 'A-5')],
    });
    const r = validateSeason(s, HOUSE_LEAGUE);
    const hh = r.violations.filter((v) => v.code === 'HOUSEHOLD_OVERLOADED');
    expect(hh.length).toBe(1);
    expect(hh[0]!.message).toContain('3 separate sessions');
  });

  it('ignores households entirely for the adult league', () => {
    const s = Season.parse({
      id: 'a', name: 'A', leagueId: 'adult',
      startDate: '2027-01-01', endDate: '2027-03-01',
      divisions: [{ id: 'A', name: 'A', gamesPerTeam: 1 }],
      teams: ['A-1', 'A-2', 'A-3', 'A-4'].map((n) => ({ id: n, divisionId: 'A', name: n })),
      slots: [1, 2].map((i) => ({
        id: `s${i}`, date: '2027-01-10', start: `1${i}:00`, minutes: 60, rink: `R${i}`, use: 'game',
      })),
      games: [
        { id: 'g1', divisionId: 'A', slotId: 's1', homeTeamId: 'A-1', awayTeamId: 'A-2' },
        { id: 'g2', divisionId: 'A', slotId: 's2', homeTeamId: 'A-3', awayTeamId: 'A-4' },
      ],
      people: [
        { id: 'x', firstName: 'X', lastName: 'Y', divisionId: null, teamId: 'A-1', birthDate: null,
          householdId: 'hh', guardianName: '', guardianEmail: '', jerseyNumber: null,
          jerseySize: '', sockSize: '', numberPrefs: [], registeredAt: '' },
        { id: 'z', firstName: 'Z', lastName: 'Y', divisionId: null, teamId: 'A-3', birthDate: null,
          householdId: 'hh', guardianName: '', guardianEmail: '', jerseyNumber: null,
          jerseySize: '', sockSize: '', numberPrefs: [], registeredAt: '' },
      ],
    });
    expect(validateSeason(s, ADULT_LEAGUE).violations.map((v) => v.code))
      .not.toContain('HOUSEHOLD_OVERLOADED');
  });
});

describe('division integrity and shared ice', () => {
  it('rejects a game between teams in different divisions', () => {
    const s = Season.parse({
      id: 'x', name: 'X', leagueId: 'middle_school',
      startDate: '2026-11-01', endDate: '2027-01-31',
      divisions: [{ id: 'N', name: 'North' }, { id: 'S', name: 'South' }],
      teams: [
        { id: 'N-1', divisionId: 'N', name: 'N1' },
        { id: 'S-1', divisionId: 'S', name: 'S1' },
      ],
      slots: [{ id: 'a', date: '2026-11-07', start: '09:00', minutes: 60, rink: 'R', use: 'game' }],
      games: [{ id: 'g', divisionId: 'N', slotId: 'a', homeTeamId: 'N-1', awayTeamId: 'S-1' }],
    });
    expect(validateSeason(s, MIDDLE_SCHOOL_LEAGUE).violations.map((v) => v.code))
      .toContain('CROSS_DIVISION_GAME');
  });

  it('catches two leagues booking the same sheet of ice', () => {
    const mk = (id: string, leagueId: string, date: string, start: string) => Season.parse({
      id, name: id, leagueId, startDate: '2026-11-01', endDate: '2027-03-31',
      divisions: [{ id: 'D', name: 'D' }],
      teams: [{ id: `${id}-1`, divisionId: 'D', name: `${id}-1` },
              { id: `${id}-2`, divisionId: 'D', name: `${id}-2` }],
      slots: [{ id: `${id}-s`, date, start, minutes: 60, rink: 'Red Hawk', use: 'game' }],
      games: [{ id: `${id}-g`, divisionId: 'D', slotId: `${id}-s`,
                homeTeamId: `${id}-1`, awayTeamId: `${id}-2` }],
    });
    const clash = findIceConflicts([
      mk('ms', 'middle_school', '2026-12-12', '09:00'),
      mk('house', 'house', '2026-12-12', '09:00'),
    ]);
    expect(clash.length).toBe(1);
    expect(clash[0]!.bookings.map((b) => b.leagueId).sort()).toEqual(['house', 'middle_school']);
  });

  it('catches a PARTIAL overlap that equal-start matching would miss', () => {
    // MSL 20:10 for 80 minutes runs to 21:30; House 20:30 for 60 runs to 21:30.
    // Different start times, same sheet, same night.
    const mk = (id: string, leagueId: string, start: string, minutes: number) => Season.parse({
      id, name: id, leagueId, startDate: '2026-11-01', endDate: '2027-03-31',
      divisions: [{ id: 'D', name: 'D' }],
      teams: [{ id: `${id}-1`, divisionId: 'D', name: `${id}-1` },
              { id: `${id}-2`, divisionId: 'D', name: `${id}-2` }],
      slots: [{ id: `${id}-s`, date: '2027-01-15', start, minutes, rink: 'Rocky', use: 'game' }],
      games: [{ id: `${id}-g`, divisionId: 'D', slotId: `${id}-s`,
                homeTeamId: `${id}-1`, awayTeamId: `${id}-2` }],
    });
    const clash = findIceConflicts([
      mk('ms', 'middle_school', '20:10', 80),
      mk('house', 'house', '20:30', 60),
    ]);
    expect(clash.length).toBe(1);
    expect(clash[0]!.from).toBe('20:10');
    expect(clash[0]!.to).toBe('21:30');
  });

  it('does not flag back-to-back bookings that merely touch', () => {
    const mk = (id: string, leagueId: string, start: string, minutes: number) => Season.parse({
      id, name: id, leagueId, startDate: '2026-11-01', endDate: '2027-03-31',
      divisions: [{ id: 'D', name: 'D' }],
      teams: [{ id: `${id}-1`, divisionId: 'D', name: `${id}-1` },
              { id: `${id}-2`, divisionId: 'D', name: `${id}-2` }],
      slots: [{ id: `${id}-s`, date: '2027-01-15', start, minutes, rink: 'Rocky', use: 'game' }],
      games: [{ id: `${id}-g`, divisionId: 'D', slotId: `${id}-s`,
                homeTeamId: `${id}-1`, awayTeamId: `${id}-2` }],
    });
    // 19:00+80 = 20:20, next starts exactly 20:20.
    expect(findIceConflicts([
      mk('ms', 'middle_school', '19:00', 80),
      mk('house', 'house', '20:20', 60),
    ])).toEqual([]);
  });

  it('leaves two leagues alone when they use different ice', () => {
    const mk = (id: string, leagueId: string, date: string) => Season.parse({
      id, name: id, leagueId, startDate: '2026-11-01', endDate: '2027-03-31',
      divisions: [{ id: 'D', name: 'D' }],
      teams: [{ id: `${id}-1`, divisionId: 'D', name: `${id}-1` },
              { id: `${id}-2`, divisionId: 'D', name: `${id}-2` }],
      slots: [{ id: `${id}-s`, date, start: '09:00', minutes: 60, rink: 'Red Hawk', use: 'game' }],
      games: [{ id: `${id}-g`, divisionId: 'D', slotId: `${id}-s`,
                homeTeamId: `${id}-1`, awayTeamId: `${id}-2` }],
    });
    expect(findIceConflicts([
      mk('ms', 'middle_school', '2026-12-12'),
      mk('house', 'house', '2026-12-13'),
    ])).toEqual([]);
  });
});

describe('away games and ice turnaround', () => {
  const away = (date: string, start: string, minutes = 60) => ({
    facility: 'Codey Arena', city: 'West Orange', date, start, minutes,
  });

  it('counts an away game toward the game total without using our ice', () => {
    const s = Season.parse({
      id: 'a', name: 'A', leagueId: 'house',
      startDate: '2027-01-01', endDate: '2027-03-01',
      divisions: [{ id: 'D', name: 'D', gamesPerTeam: 1, practicesPerTeam: 0 }],
      teams: [{ id: 'T1', divisionId: 'D', name: 'T1' }, { id: 'T2', divisionId: 'D', name: 'T2' }],
      slots: [],
      games: [{ id: 'g', divisionId: 'D', homeTeamId: 'T1', awayTeamId: 'T2',
                away: away('2027-01-09', '17:00') }],
    });
    const r = validateSeason(s, HOUSE_LEAGUE);
    expect(r.teams.map((t) => t.games)).toEqual([1, 1]);
    expect(r.teams.map((t) => t.awayGames)).toEqual([1, 1]);
    expect(r.errorCount).toBe(0);
  });

  it('treats an away game as making the team busy that day', () => {
    const s = Season.parse({
      id: 'a', name: 'A', leagueId: 'house',
      startDate: '2027-01-01', endDate: '2027-03-01',
      divisions: [{ id: 'D', name: 'D', gamesPerTeam: 2, practicesPerTeam: 0 }],
      teams: [{ id: 'T1', divisionId: 'D', name: 'T1' }, { id: 'T2', divisionId: 'D', name: 'T2' }],
      slots: [{ id: 's', date: '2027-01-09', start: '12:00', minutes: 60, rink: 'R', use: 'game' }],
      games: [
        { id: 'g1', divisionId: 'D', slotId: 's', homeTeamId: 'T1', awayTeamId: 'T2' },
        { id: 'g2', divisionId: 'D', homeTeamId: 'T1', awayTeamId: 'T2',
          away: away('2027-01-09', '17:00') },
      ],
    });
    // Noon at our rink and five o'clock at theirs is a five-hour day with a
    // drive in the middle. The away game still makes the team busy; what the
    // validator now says is what kind of day that is.
    expect(validateSeason(s, HOUSE_LEAGUE).violations.map((v) => v.code))
      .toContain('SAME_DAY_GAP');
  });

  it('rejects a game that is both at home and away', () => {
    const s = Season.parse({
      id: 'a', name: 'A', leagueId: 'house',
      startDate: '2027-01-01', endDate: '2027-03-01',
      divisions: [{ id: 'D', name: 'D', gamesPerTeam: 1, practicesPerTeam: 0 }],
      teams: [{ id: 'T1', divisionId: 'D', name: 'T1' }, { id: 'T2', divisionId: 'D', name: 'T2' }],
      slots: [{ id: 's', date: '2027-01-09', start: '12:00', minutes: 60, rink: 'R', use: 'game' }],
      games: [{ id: 'g', divisionId: 'D', slotId: 's', homeTeamId: 'T1', awayTeamId: 'T2',
                away: away('2027-01-09', '17:00') }],
    });
    expect(validateSeason(s, HOUSE_LEAGUE).violations.map((v) => v.code))
      .toContain('GAME_BOTH_HOME_AND_AWAY');
  });

  it('does not apply our weekday rules to a game at someone else\'s rink', () => {
    // 2027-01-13 is a Wednesday; Middle School plays Fri/Sat/Sun on OUR ice.
    const s = Season.parse({
      id: 'a', name: 'A', leagueId: 'middle_school',
      startDate: '2027-01-01', endDate: '2027-03-01',
      divisions: [{ id: 'D', name: 'D', gamesPerTeam: 1 }],
      teams: [{ id: 'T1', divisionId: 'D', name: 'T1' }, { id: 'T2', divisionId: 'D', name: 'T2' }],
      slots: [],
      games: [{ id: 'g', divisionId: 'D', homeTeamId: 'T1', awayTeamId: 'T2',
                away: away('2027-01-13', '18:00') }],
    });
    expect(validateSeason(s, MIDDLE_SCHOOL_LEAGUE).violations.map((v) => v.code))
      .not.toContain('LEAGUE_WEEKDAY_NOT_ALLOWED');
  });

  it('flags two bookings on one sheet with no time to cut the ice', () => {
    const s = Season.parse({
      id: 'a', name: 'A', leagueId: 'house',
      startDate: '2027-01-01', endDate: '2027-03-01',
      divisions: [{ id: 'D', name: 'D', gamesPerTeam: 1, practicesPerTeam: 0 }],
      teams: ['T1', 'T2', 'T3', 'T4'].map((n) => ({ id: n, divisionId: 'D', name: n })),
      slots: [
        { id: 's1', date: '2027-01-09', start: '12:00', minutes: 80, rink: 'Rocky', use: 'game' },
        { id: 's2', date: '2027-01-09', start: '13:20', minutes: 80, rink: 'Rocky', use: 'game' },
      ],
      games: [
        { id: 'g1', divisionId: 'D', slotId: 's1', homeTeamId: 'T1', awayTeamId: 'T2' },
        { id: 'g2', divisionId: 'D', slotId: 's2', homeTeamId: 'T3', awayTeamId: 'T4' },
      ],
    });
    const codes = validateSeason(s, HOUSE_LEAGUE).violations.map((v) => v.code);
    expect(codes).toContain('TURNAROUND_TOO_SHORT');   // 12:00+80 = 13:20, zero gap
  });

  it('accepts a sensible gap between bookings', () => {
    const s = Season.parse({
      id: 'a', name: 'A', leagueId: 'house',
      startDate: '2027-01-01', endDate: '2027-03-01',
      divisions: [{ id: 'D', name: 'D', gamesPerTeam: 1, practicesPerTeam: 0 }],
      teams: ['T1', 'T2', 'T3', 'T4'].map((n) => ({ id: n, divisionId: 'D', name: n })),
      slots: [
        { id: 's1', date: '2027-01-09', start: '12:00', minutes: 70, rink: 'Rocky', use: 'game' },
        { id: 's2', date: '2027-01-09', start: '13:20', minutes: 70, rink: 'Rocky', use: 'game' },
      ],
      games: [
        { id: 'g1', divisionId: 'D', slotId: 's1', homeTeamId: 'T1', awayTeamId: 'T2' },
        { id: 'g2', divisionId: 'D', slotId: 's2', homeTeamId: 'T3', awayTeamId: 'T4' },
      ],
    });
    expect(validateSeason(s, HOUSE_LEAGUE).violations.map((v) => v.code))
      .not.toContain('TURNAROUND_TOO_SHORT');
  });
});

describe('cross-ice is not a double booking', () => {
  it('allows two games sharing one cross-ice slot', () => {
    const s = Season.parse({
      id: 'x', name: 'X', leagueId: 'house',
      startDate: '2027-01-01', endDate: '2027-03-01',
      divisions: [{ id: 'D', name: 'D', gamesPerTeam: 1, practicesPerTeam: 0 }],
      teams: ['T1', 'T2', 'T3', 'T4'].map((n) => ({ id: n, divisionId: 'D', name: n })),
      slots: [{ id: 's', date: '2027-01-09', start: '07:00', minutes: 70,
                rink: 'Red Hawk', use: 'game', capacity: 2 }],
      games: [
        { id: 'g1', divisionId: 'D', slotId: 's', homeTeamId: 'T1', awayTeamId: 'T2' },
        { id: 'g2', divisionId: 'D', slotId: 's', homeTeamId: 'T3', awayTeamId: 'T4' },
      ],
    });
    const codes = validateSeason(s, HOUSE_LEAGUE).violations.map((v) => v.code);
    expect(codes).not.toContain('ICE_DOUBLE_BOOKED');
    expect(codes).not.toContain('SLOT_OVERBOOKED');
  });

  it('still catches a third game crammed into that slot', () => {
    const s = Season.parse({
      id: 'x', name: 'X', leagueId: 'house',
      startDate: '2027-01-01', endDate: '2027-03-01',
      divisions: [{ id: 'D', name: 'D', gamesPerTeam: 1, practicesPerTeam: 0 }],
      teams: ['T1', 'T2', 'T3', 'T4', 'T5', 'T6'].map((n) => ({ id: n, divisionId: 'D', name: n })),
      slots: [{ id: 's', date: '2027-01-09', start: '07:00', minutes: 70,
                rink: 'Red Hawk', use: 'game', capacity: 2 }],
      games: [
        { id: 'g1', divisionId: 'D', slotId: 's', homeTeamId: 'T1', awayTeamId: 'T2' },
        { id: 'g2', divisionId: 'D', slotId: 's', homeTeamId: 'T3', awayTeamId: 'T4' },
        { id: 'g3', divisionId: 'D', slotId: 's', homeTeamId: 'T5', awayTeamId: 'T6' },
      ],
    });
    expect(validateSeason(s, HOUSE_LEAGUE).violations.map((v) => v.code))
      .toContain('SLOT_OVERBOOKED');
  });
});
