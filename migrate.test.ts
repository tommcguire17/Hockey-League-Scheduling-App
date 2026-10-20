import { describe, it, expect } from 'vitest';
import { importAppState } from '@league/io';
import { validateSeason, manifestFor } from '@league/core';

/** The shape both standalone HTML schedulers keep in localStorage. */
const app = {
  name: 'Adult League 2026-27', start: '2026-09-13', end: '2026-10-11',
  cap: 8, pcap: 0, playoffTeams: 4, venue: 'MSU Arena', city: 'Little Falls',
  divisions: [
    { id: 'd1', name: 'Open', days: '', start: '', end: '', cap: '', pcap: '' },
    { id: 'd2', name: '35+', days: '', start: '', end: '', cap: '6', pcap: '' },
  ],
  teams: [
    { id: 't1', name: 'Alpha', div: 'd1', days: '', pcap: '' },
    { id: 't2', name: 'Bravo', div: 'd1', days: 'tue,thu', pcap: '' },
    { id: 't3', name: 'Charlie', div: 'd2', days: '', blackouts: '9/20/2026, 2026-10-04' },
    { id: 't4', name: 'Delta', div: 'd2', days: '', pcap: '' },
  ],
  // a weekly pattern, expanded across the season
  lines: [{ day: 'Sunday', time: '21:00', mins: 75, rink: 'Red Hawk Rink', use: 'games' }],
  // and two one-off dated slots
  extras: [
    { id: 's1', date: '2026-09-15', time: '20:10', mins: 80, rink: 'Rocky Rink', use: 'games' },
    { id: 's2', date: '2026-09-22', time: '7:00 PM', mins: 60, rink: 'Rocky', use: 'practice' },
  ],
  closures: [{ date: '2026-09-27' }],
  blackouts: [],
};

describe('migrating from the standalone HTML scheduler', () => {
  const { season, issues } = importAppState(JSON.stringify(app), { leagueId: 'adult' });

  it('carries over the season, divisions and teams', () => {
    expect(season.name).toBe('Adult League 2026-27');
    expect(season.leagueId).toBe('adult');
    expect(season.startDate).toBe('2026-09-13');
    expect(season.divisions.map((d) => d.name)).toEqual(['Open', '35+']);
    expect(season.teams.map((t) => t.name)).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta']);
  });

  it('reads a per-division game target and leaves a blank one on the league default', () => {
    expect(season.divisions[0]!.gamesPerTeam).toBeNull();
    expect(season.divisions[1]!.gamesPerTeam).toBe(6);
  });

  it('turns "tue,thu" into real weekday restrictions', () => {
    expect(season.teams[1]!.allowedWeekdays).toEqual(['tuesday', 'thursday']);
    expect(season.teams[0]!.allowedWeekdays).toEqual([]);
  });

  it('normalises team blackout dates whatever format they were typed in', () => {
    expect(season.teams[2]!.blackoutDates).toEqual(['2026-09-20', '2026-10-04']);
  });

  it('expands a weekly line into dated slots and skips closed dates', () => {
    const sundays = season.slots.filter((s) => s.start === '21:00');
    // Sundays from 9/13 to 10/11 are 13, 20, 27, 4, 11 — with 9/27 closed.
    expect(sundays.map((s) => s.date)).toEqual(
      ['2026-09-13', '2026-09-20', '2026-10-04', '2026-10-11']);
    expect(season.blackoutDates).toEqual(['2026-09-27']);
  });

  it('keeps the dated one-offs and normalises their rink names and times', () => {
    const rocky = season.slots.filter((s) => s.rink === 'Rocky');
    expect(rocky.length).toBe(2);
    expect(rocky.find((s) => s.date === '2026-09-22')!.start).toBe('19:00');
    expect(season.slots.some((s) => s.rink.endsWith(' Rink'))).toBe(false);
  });

  it('produces a season the validator accepts', () => {
    const r = validateSeason(season, manifestFor('adult'));
    expect(r.violations.filter((v) => v.severity === 'error')).toEqual([]);
  });

  it('reports rather than silently dropping an unreadable row', () => {
    const bad = { ...app, extras: [...app.extras, { id: 'x', date: 'whenever', time: '??' }] };
    const r = importAppState(JSON.stringify(bad), { leagueId: 'adult' });
    expect(r.issues.some((i) => i.message.includes('unreadable'))).toBe(true);
  });

  it('refuses a file that is not JSON, naming the problem', () => {
    expect(() => importAppState('<html>', { leagueId: 'adult' }))
      .toThrow(/not valid JSON/);
  });
});
