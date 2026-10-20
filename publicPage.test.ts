import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { publicPage, loadSeason } from '@league/io';
import { HOUSE_LEAGUE, resolveBracket } from '@league/core';

const base = loadSeason(readFileSync('fixtures/mini.season.json', 'utf8'));
const scored = {
  ...base,
  games: base.games.map((g, i) =>
    g.type === 'regular' ? { ...g, homeGoals: 3 + i, awayGoals: 1 } : g),
  changes: [{
    id: 'c1', gameId: base.games[0]!.id, at: '2027-01-05T10:00:00.000Z',
    from: { date: '2027-01-09', start: '09:00', rink: 'North', away: false },
    to: { date: '2027-01-16', start: '18:30', rink: 'North', away: false },
    reason: 'ice-failure' as const, note: 'Compressor down', announced: true,
  }],
};

describe('the public schedule page', () => {
  const html = publicPage(scored, HOUSE_LEAGUE);

  it('is one self-contained file with nothing loaded from elsewhere', () => {
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+href=/i);
    expect(html).not.toMatch(/https?:\/\//);
  });

  it('shows every game with real team names and dates people read', () => {
    expect(html).toContain('Aces');
    expect(html).toContain('Saturday 9 January 2027');
    expect(html).not.toContain('2027-01-09<');
  });

  it('shows scores and standings once results are in', () => {
    expect(html).toContain('Standings');
    expect(html).toContain('3&ndash;1');
  });

  it('marks a rescheduled game and explains why', () => {
    expect(html).toContain('rescheduled');
    expect(html).toContain('Ice or plant failure');
    expect(html).toContain('Compressor down');
  });

  it('carries no player names or contact details', () => {
    const withPeople = { ...scored, people: [{
      id: 'p1', firstName: 'Ada', lastName: 'LOVELACE', divisionId: null, teamId: 'A-1',
      birthDate: '2015-01-01', householdId: 'hh', guardianName: 'Guardian Name',
      guardianEmail: 'guardian@example.com', jerseyNumber: 7, jerseySize: '', sockSize: '',
      numberPrefs: [], registeredAt: '',
    }] };
    const out = publicPage(withPeople, HOUSE_LEAGUE);
    for (const leak of ['Ada', 'LOVELACE', 'guardian@example.com', 'Guardian Name', '2015-01-01']) {
      expect(out).not.toContain(leak);
    }
  });

  it('escapes anything a team name could smuggle in', () => {
    const nasty = {
      ...base,
      teams: base.teams.map((t, i) =>
        i === 0 ? { ...t, name: '<script>alert(1)</script>' } : t),
    };
    const out = publicPage(nasty, HOUSE_LEAGUE);
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out).not.toContain('<script>alert(1)</script>');
  });

  it('leaves standings out for a league that does not keep them', () => {
    const noTable = { ...HOUSE_LEAGUE, capabilities: { ...HOUSE_LEAGUE.capabilities, standings: false } };
    expect(publicPage(scored, noTable)).not.toContain('Standings');
  });

  it('includes an away game with the other rink named', () => {
    const withAway = {
      ...base,
      games: [...base.games, {
        id: 'ga', divisionId: 'A', slotId: null, homeTeamId: 'A-1', awayTeamId: 'A-2',
        homeLabel: '', awayLabel: '', type: 'regular' as const,
        homeGoals: null, awayGoals: null, locked: false,
        away: { facility: 'Codey Arena', city: 'West Orange',
                date: '2027-02-06', start: '18:30', minutes: 75 },
      }],
    };
    const out = publicPage(withAway, HOUSE_LEAGUE);
    expect(out).toContain('Codey Arena');
    expect(out).toContain('away');
  });
});

describe('the public page with a bracket', () => {
  // Built by hand rather than with the engine: io must not depend on it.
  const seeded = { ...scored, divisions: scored.divisions.map((d) => ({ ...d, playoffTeams: 2 })) };
  const games = seeded.games.map((g) => (g.type === 'final' ? {
    ...g,
    homeFrom: { kind: 'seed' as const, rank: 1, gameId: null },
    awayFrom: { kind: 'seed' as const, rank: 2, gameId: null },
  } : g));
  const bracketed = resolveBracket({ ...seeded, games }, HOUSE_LEAGUE);
  const html = publicPage(bracketed, HOUSE_LEAGUE);

  it('draws the bracket, not just a row in the schedule', () => {
    expect(html).toContain('Playoffs');
    expect(html).toContain('class="brk"');
    expect(html).toContain('Final');
  });

  it('is still one self-contained file', () => {
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/https?:\/\//);
  });

  it('names the champion once the final is played', () => {
    const final = bracketed.games.find((g) => g.type === 'final')!;
    const won = {
      ...bracketed,
      games: bracketed.games.map(
        (g) => (g.id === final.id ? { ...g, homeGoals: 4, awayGoals: 1 } : g)),
    };
    const page = publicPage(won, HOUSE_LEAGUE);
    expect(page).toContain('class="champ"');
    expect(page).toMatch(/class="sd won"/);
  });

  it('leaves no bracket section at all when there is no bracket', () => {
    const none = { ...scored, games: scored.games.filter((g) => g.type === 'regular') };
    const page = publicPage(none, HOUSE_LEAGUE);
    expect(page).not.toContain('class="brk"');
    expect(page).not.toContain('<h2>Playoffs</h2>');
  });
});
