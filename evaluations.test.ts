import { describe, it, expect } from 'vitest';
import {
  Season, HOUSE_LEAGUE, ADULT_LEAGUE, MIDDLE_SCHOOL_LEAGUE,
  evaluationReadiness, evaluationStatus, isRepurposed, markEvaluationIce,
  playFloors, playableOn, validateSeason,
} from '@league/core';

/**
 * 8U evaluates on 1 November, 10U on the 1st and the 2nd — two sessions,
 * because signups were heavy. Nothing either division does may start before
 * its own last session.
 */
const base = (patch: Record<string, unknown> = {}) => Season.parse({
  id: 's', name: 'S', leagueId: 'house', startDate: '2026-11-01', endDate: '2027-03-31',
  divisions: [
    { id: '8U', name: '8U', gamesPerTeam: 2, practicesPerTeam: 1, evaluationSessions: 1 },
    { id: '10U', name: '10U', gamesPerTeam: 2, practicesPerTeam: 1, evaluationSessions: 2 },
  ],
  teams: ['8U', '10U'].flatMap((d) => [1, 2].map((i) => ({
    id: `${d}-${i}`, divisionId: d, name: `${d} ${i}`,
  }))),
  slots: [
    { id: 'e8', date: '2026-11-01', start: '19:00', minutes: 60, rink: 'R', use: 'evaluation', ownerDivisionId: '8U', ownerPolicy: 'exclusive' },
    { id: 'e10a', date: '2026-11-01', start: '20:10', minutes: 60, rink: 'R', use: 'evaluation', ownerDivisionId: '10U', ownerPolicy: 'exclusive' },
    { id: 'e10b', date: '2026-11-02', start: '20:10', minutes: 60, rink: 'R', use: 'evaluation', ownerDivisionId: '10U', ownerPolicy: 'exclusive' },
    { id: 'early', date: '2026-11-01', start: '12:00', minutes: 60, rink: 'R', use: 'game' },
    { id: 'mid', date: '2026-11-02', start: '12:00', minutes: 60, rink: 'R', use: 'game' },
    { id: 'late', date: '2026-11-08', start: '12:00', minutes: 60, rink: 'R', use: 'game' },
    { id: 'prac', date: '2026-11-02', start: '17:30', minutes: 60, rink: 'R', use: 'practice', ownerDivisionId: '10U' },
  ],
  ...patch,
});

/** A league that has never run evaluations: every division sits at zero. */
const noEvaluations = () => {
  const s = base();
  return {
    ...s,
    divisions: s.divisions.map((d) => ({ ...d, evaluationSessions: 0 })),
    slots: s.slots.filter((x) => x.use !== 'evaluation'),
  };
};

const game = (id: string, div: string, slotId: string) =>
  ({ id, divisionId: div, slotId, homeTeamId: `${div}-1`, awayTeamId: `${div}-2` });

describe('the floor evaluations put under a season', () => {
  it('is the LAST session, not the first', () => {
    const f = playFloors(base());
    expect(f.get('8U')).toBe('2026-11-01');
    expect(f.get('10U')).toBe('2026-11-02');     // two sessions; the later one counts
  });

  it('is per division, so an age group that finishes early starts early', () => {
    const f = playFloors(base());
    expect(playableOn(f, '8U', '2026-11-02')).toBe(true);
    expect(playableOn(f, '10U', '2026-11-02')).toBe(false);
    expect(playableOn(f, '10U', '2026-11-03')).toBe(true);
  });

  it('leaves a division with no evaluation ice unconstrained', () => {
    const f = playFloors(base());
    expect(playableOn(f, '15U', '2026-11-01')).toBe(true);
  });

  it('still holds when the evaluation is booked on relabelled ice', () => {
    const s = base();
    const moved = {
      ...s,
      slots: s.slots.map((x) => (x.id === 'e8' ? { ...x, use: 'game' as const } : x)),
      practices: [{
        id: 'ev', divisionId: '8U', slotId: 'e8',
        teamIds: ['8U-1'], kind: 'evaluation' as const,
      }],
    };
    expect(playFloors(moved).get('8U')).toBe('2026-11-01');
  });
});

describe('the validator on evaluations', () => {
  const codes = (s: ReturnType<typeof base>) =>
    validateSeason(s, HOUSE_LEAGUE).violations.map((v) => v.code);

  it('refuses a game before the division is evaluated', () => {
    const s = base({ games: [game('g1', '10U', 'mid')] });   // 2 Nov, floor is 2 Nov
    expect(codes(s)).toContain('PLAY_BEFORE_EVALUATION');
    const v = validateSeason(s, HOUSE_LEAGUE);
    expect(v.violations.find((x) => x.code === 'PLAY_BEFORE_EVALUATION')!.severity).toBe('error');
  });

  it('allows the same date for a division that finished evaluating earlier', () => {
    expect(codes(base({ games: [game('g1', '8U', 'mid')] })))
      .not.toContain('PLAY_BEFORE_EVALUATION');
  });

  it('refuses a practice before the evaluation too', () => {
    const s = base({
      practices: [{ id: 'p1', divisionId: '10U', slotId: 'prac', teamIds: ['10U-1'] }],
    });
    expect(codes(s)).toContain('PLAY_BEFORE_EVALUATION');
  });

  it('is happy once everything sits after the floor', () => {
    const s = base({ games: [game('g1', '10U', 'late'), game('g2', '8U', 'mid')] });
    expect(codes(s)).not.toContain('PLAY_BEFORE_EVALUATION');
  });

  it('is quiet when a division has the sessions it asked for', () => {
    expect(codes(base())).not.toContain('EVALUATION_ICE_SHORT');
  });

  it('says so when a division is a sheet short of what it needs', () => {
    const s = base();
    expect(codes({ ...s, slots: s.slots.filter((x) => x.id !== 'e10b') }))
      .toContain('EVALUATION_ICE_SHORT');
  });

  it('says when a division has none at all', () => {
    const s = base();
    expect(codes({ ...s, slots: s.slots.filter((x) => x.id !== 'e8') }))
      .toContain('EVALUATION_ICE_MISSING');
  });

  it('does not ask for evaluations a division does not run', () => {
    const none = noEvaluations();
    const c = codes(none);
    expect(c).not.toContain('EVALUATION_ICE_MISSING');
    expect(c).not.toContain('EVALUATION_ICE_SHORT');
  });
});

describe('leagues that have never run evaluations', () => {
  it('say so by leaving every division at zero, with no separate flag', () => {
    const none = noEvaluations();
    expect(none.divisions.every((d) => d.evaluationSessions === 0)).toBe(true);
    expect(evaluationStatus(none).every((x) => x.fulfilled)).toBe(true);
  });

  it('are never nagged about ice they do not need', () => {
    const c = validateSeason(noEvaluations(), MIDDLE_SCHOOL_LEAGUE).violations.map((v) => v.code);
    expect(c).not.toContain('EVALUATION_ICE_MISSING');
    expect(c).not.toContain('EVALUATION_ICE_SHORT');
  });

  it('take parity by ticking the number up, and nothing else', () => {
    const s = noEvaluations();
    const wants = { ...s, divisions: s.divisions.map((d) => ({ ...d, evaluationSessions: 1 })) };
    expect(validateSeason(wants, MIDDLE_SCHOOL_LEAGUE).violations.map((v) => v.code))
      .toContain('EVALUATION_ICE_MISSING');
  });
});

describe('ready or not, rather than a count', () => {
  const of = (s: ReturnType<typeof base>, div: string) =>
    evaluationStatus(s).find((x) => x.divisionId === div)!;

  it('is fulfilled when there is ice and nothing is scheduled before it', () => {
    const s = base({ games: [game('g1', '10U', 'late')] });
    expect(of(s, '10U')).toMatchObject({ fulfilled: true, blockers: [], booked: 2 });
  });

  it('is not fulfilled with no evaluation ice, and says so', () => {
    const s = base();
    const none = { ...s, slots: s.slots.filter((x) => x.id !== 'e8') };
    expect(of(none, '8U').fulfilled).toBe(false);
    expect(of(none, '8U').blockers).toEqual(['no evaluation ice']);
  });

  it('is not fulfilled when the division plays before it, and says which date', () => {
    const s = base({ games: [game('g1', '10U', 'mid')] });
    expect(of(s, '10U').fulfilled).toBe(false);
    expect(of(s, '10U').blockers[0]).toMatch(/plays on 2026-11-02, before its last evaluation/);
  });

  it('counts the sessions a division asked for', () => {
    const s = base();
    expect(of(s, '10U').blockers).toEqual([]);
    const more = {
      ...s, divisions: s.divisions.map((d) => (d.id === '10U' ? { ...d, evaluationSessions: 4 } : d)),
    };
    expect(of(more, '10U').blockers[0]).toMatch(/2 of 4 sessions booked/);
  });

  it('gives the league one percentage, with a denominator nobody maintains', () => {
    const all = base({ games: [game('g1', '10U', 'late')] });
    expect(evaluationReadiness(all))
      .toMatchObject({ ready: 2, total: 2, percent: 100, fulfilled: true });

    const half = { ...all, slots: all.slots.filter((x) => x.id !== 'e8') };
    expect(evaluationReadiness(half))
      .toMatchObject({ ready: 1, total: 2, percent: 50, fulfilled: false });
  });

  it('is 100% for a league that does not run evaluations at all', () => {
    expect(evaluationReadiness(noEvaluations()))
      .toMatchObject({ total: 0, percent: 100, fulfilled: true });
  });
});


describe('an older season, where the slot and the session disagree', () => {
  /** How the workbook import left it: an evaluation sitting on game ice. */
  const legacy = () => {
    const s = base();
    return {
      ...s,
      slots: s.slots.map((x) => (x.id === 'e8' ? { ...x, use: 'game' as const, bookedUse: null } : x)),
      practices: [{
        id: 'ev8', divisionId: '8U', slotId: 'e8',
        teamIds: ['8U-1', '8U-2'], kind: 'evaluation' as const,
      }],
    };
  };

  it('marks the ice the evaluation is actually on', () => {
    const fixed = markEvaluationIce(legacy());
    const slot = fixed.slots.find((x) => x.id === 'e8')!;
    expect(slot.use).toBe('evaluation');
    expect(slot.ownerDivisionId).toBe('8U');
    expect(slot.ownerPolicy).toBe('exclusive');
  });

  it('records it as the repurpose it always was', () => {
    const slot = markEvaluationIce(legacy()).slots.find((x) => x.id === 'e8')!;
    expect(slot.bookedUse).toBe('game');
    expect(isRepurposed(slot)).toBe(true);
    expect(slot.repurposeNote).toMatch(/evaluation skate/);
  });

  it('stops the season being told it has no evaluation ice', () => {
    const before = validateSeason(legacy(), HOUSE_LEAGUE).violations.map((v) => v.code);
    const after = validateSeason(markEvaluationIce(legacy()), HOUSE_LEAGUE)
      .violations.filter((v) => v.subject === '8U').map((v) => v.code);
    expect(before).toContain('EVALUATION_ICE_MISSING');
    expect(after).not.toContain('EVALUATION_ICE_MISSING');
  });

  it('takes the session count from the ice the season actually ran', () => {
    const s = base();
    const unset = { ...s, divisions: s.divisions.map((d) => ({ ...d, evaluationSessions: 0 })) };
    const fixed = markEvaluationIce({
      ...unset,
      practices: [
        { id: 'a', divisionId: '10U', slotId: 'e10a', teamIds: [], kind: 'evaluation' as const },
        { id: 'b', divisionId: '10U', slotId: 'e10b', teamIds: [], kind: 'evaluation' as const },
      ],
    });
    expect(fixed.divisions.find((d) => d.id === '10U')!.evaluationSessions).toBe(2);
  });

  it('leaves a season that is already consistent exactly as it is', () => {
    const s = base();
    expect(markEvaluationIce(s)).toBe(s);
  });
});
