import { describe, it, expect } from 'vitest';
import {
  Season, HOUSE_LEAGUE, IceRule, applyIceRules, applySuggestions, iceDifferences,
  isRepurposed, repurposeSlot, repurposedSlots, revertSlot, slotIsBusy, suggestRepurpose,
} from '@league/core';

/** A Sunday 7am sheet the building booked as an 8U game, plus practice ice. */
const base = (patch: Record<string, unknown> = {}) => Season.parse({
  id: 's', name: 'S', leagueId: 'house', startDate: '2026-11-01', endDate: '2027-03-31',
  divisions: [
    { id: '8U', name: '8U', gamesPerTeam: 6, practicesPerTeam: 4 },
    { id: '10U', name: '10U', gamesPerTeam: 6, practicesPerTeam: 4 },
  ],
  teams: ['8U', '10U'].flatMap((d) => [1, 2].map((i) => ({
    id: `${d}-${i}`, divisionId: d, name: `${d} ${i}`,
  }))),
  slots: [
    { id: 'sun7', date: '2026-11-22', start: '07:00', minutes: 70, rink: 'Red Hawk', use: 'game', bookedUse: 'game', ownerDivisionId: '8U' },
    { id: 'wed', date: '2026-11-25', start: '18:10', minutes: 60, rink: 'Red Hawk', use: 'practice', bookedUse: 'practice', ownerDivisionId: '8U' },
    { id: 'thu', date: '2026-11-26', start: '18:10', minutes: 60, rink: 'Red Hawk', use: 'practice', bookedUse: 'practice' },
    { id: 'fri', date: '2026-11-27', start: '18:10', minutes: 60, rink: 'Red Hawk', use: 'unused', bookedUse: 'unused' },
    { id: 'sat', date: '2026-11-28', start: '07:00', minutes: 70, rink: 'Rocky', use: 'game', bookedUse: 'game' },
  ],
  ...patch,
});

describe('repurposing a slot', () => {
  it('remembers what the building booked', () => {
    const s = repurposeSlot(base(), 'sun7', 'evaluation', { note: 'parents expect this hour' });
    const slot = s.slots.find((x) => x.id === 'sun7')!;
    expect(slot.use).toBe('evaluation');
    expect(slot.bookedUse).toBe('game');
    expect(slot.repurposeNote).toBe('parents expect this hour');
    expect(isRepurposed(slot)).toBe(true);
  });

  it('keeps the ORIGINAL booking through a second change of mind', () => {
    let s = repurposeSlot(base(), 'sun7', 'evaluation', { note: 'first' });
    s = repurposeSlot(s, 'sun7', 'practice', { note: 'second' });
    const slot = s.slots.find((x) => x.id === 'sun7')!;
    expect(slot.bookedUse).toBe('game');       // not 'evaluation'
    expect(slot.repurposeNote).toBe('second');
  });

  it('gives evaluation ice to its division outright', () => {
    const s = repurposeSlot(base(), 'sun7', 'evaluation', { divisionId: '8U' });
    const slot = s.slots.find((x) => x.id === 'sun7')!;
    expect(slot.ownerPolicy).toBe('exclusive');
  });

  it('stops being repurposed when it goes back to the booked use', () => {
    let s = repurposeSlot(base(), 'sun7', 'evaluation', { note: 'why' });
    s = repurposeSlot(s, 'sun7', 'game');
    const slot = s.slots.find((x) => x.id === 'sun7')!;
    expect(isRepurposed(slot)).toBe(false);
    expect(slot.repurposeNote).toBe('');
  });

  it('reverts to what the building booked', () => {
    const s = revertSlot(repurposeSlot(base(), 'sun7', 'evaluation'), 'sun7');
    expect(s.slots.find((x) => x.id === 'sun7')!.use).toBe('game');
    expect(repurposedSlots(s)).toEqual([]);
  });

  it('knows when ice has something on it', () => {
    const s = base({
      games: [{ id: 'g1', divisionId: '8U', slotId: 'sun7', homeTeamId: '8U-1', awayTeamId: '8U-2' }],
    });
    expect(slotIsBusy(s, 'sun7')).toBe(true);
    expect(slotIsBusy(s, 'wed')).toBe(false);
  });
});

describe('a rules pass must not undo a deliberate change', () => {
  const rules = [IceRule.parse({
    id: 'r', weekdays: ['sunday'], start: '07:00', setUse: 'game', divisionId: '8U',
  })];

  it('leaves repurposed ice alone by default', () => {
    const s = { ...repurposeSlot(base(), 'sun7', 'evaluation', { note: 'evals' }), iceRules: rules };
    const { season: next, skipped } = applyIceRules(s);
    expect(next.slots.find((x) => x.id === 'sun7')!.use).toBe('evaluation');
    expect(skipped).toBe(1);
  });

  it('still applies to everything else', () => {
    const s = { ...base(), iceRules: rules };
    const { season: next, skipped } = applyIceRules(s);
    expect(next.slots.find((x) => x.id === 'sun7')!.ownerDivisionId).toBe('8U');
    expect(skipped).toBe(0);
  });

  it('can be told to override, for when that is what you want', () => {
    const s = { ...repurposeSlot(base(), 'sun7', 'evaluation'), iceRules: rules };
    const { season: next } = applyIceRules(s, s.iceRules, { respectRepurposed: false });
    expect(next.slots.find((x) => x.id === 'sun7')!.use).toBe('game');
  });
});

describe('suggesting ice', () => {
  it('offers out-of-play ice before ice somebody is using', () => {
    const got = suggestRepurpose(base(), HOUSE_LEAGUE, { use: 'game', count: 3 });
    expect(got[0]!.slotId).toBe('fri');            // unused
    expect(got[0]!.why).toMatch(/nothing is lost/);
    expect(got.map((g) => g.from)).not.toContain('game');
  });

  it('never offers ice with a game already on it', () => {
    const s = base({
      games: [{ id: 'g1', divisionId: '8U', slotId: 'wed', homeTeamId: '8U-1', awayTeamId: '8U-2' }],
    });
    const got = suggestRepurpose(s, HOUSE_LEAGUE, { use: 'evaluation', count: 9 });
    expect(got.map((g) => g.slotId)).not.toContain('wed');
  });

  it('costs ice that teams are already practising on', () => {
    const s = base({
      practices: [{ id: 'p1', divisionId: '8U', slotId: 'wed', teamIds: ['8U-1', '8U-2'] }],
    });
    const got = suggestRepurpose(s, HOUSE_LEAGUE, { use: 'game', count: 9 });
    const wed = got.find((g) => g.slotId === 'wed')!;
    const fri = got.find((g) => g.slotId === 'fri')!;
    expect(wed.cost).toBeGreaterThan(fri.cost);
    expect(wed.why).toMatch(/would need another night/);
  });

  it('will not take ice another division holds outright', () => {
    const s = base();
    const locked = {
      ...s,
      slots: s.slots.map((x) => (x.id === 'thu'
        ? { ...x, ownerDivisionId: '10U', ownerPolicy: 'exclusive' as const } : x)),
    };
    const got = suggestRepurpose(locked, HOUSE_LEAGUE, {
      use: 'game', count: 9, divisionId: '8U',
    });
    expect(got.map((g) => g.slotId)).not.toContain('thu');
  });

  it('respects a date window, so playoff ice comes from after the season', () => {
    const got = suggestRepurpose(base(), HOUSE_LEAGUE, {
      use: 'game', count: 9, from: '2026-11-26',
    });
    expect(got.map((g) => g.slotId).sort()).toEqual(['fri', 'thu']);
  });

  it('returns no more than asked for', () => {
    expect(suggestRepurpose(base(), HOUSE_LEAGUE, { use: 'game', count: 1 })).toHaveLength(1);
    expect(suggestRepurpose(base(), HOUSE_LEAGUE, { use: 'game', count: 0 })).toHaveLength(0);
  });

  it('suggests nothing, and changes nothing, on its own', () => {
    const s = base();
    suggestRepurpose(s, HOUSE_LEAGUE, { use: 'game', count: 9 });
    expect(repurposedSlots(s)).toEqual([]);
  });

  it('applies a chosen set in one go', () => {
    const s = base();
    const picks = suggestRepurpose(s, HOUSE_LEAGUE, { use: 'evaluation', count: 2, divisionId: '8U' });
    const next = applySuggestions(s, picks, 'needed evaluation ice');
    expect(repurposedSlots(next)).toHaveLength(2);
    expect(next.slots.filter((x) => x.use === 'evaluation')).toHaveLength(2);
    expect(repurposedSlots(next).every((x) => x.repurposeNote === 'needed evaluation ice')).toBe(true);
  });
});

describe('the handback to the rink', () => {
  it('lists only where the booking and the schedule disagree', () => {
    const s = repurposeSlot(base(), 'sun7', 'evaluation', { note: 'parents expect 7am' });
    const diff = iceDifferences(s);
    expect(diff).toHaveLength(1);
    expect(diff[0]).toMatchObject({
      date: '2026-11-22', start: '07:00', rink: 'Red Hawk',
      bookedAs: 'game', usedAs: 'evaluation', division: '8U',
      note: 'parents expect 7am',
    });
  });

  it('says who is actually on the ice', () => {
    let s = repurposeSlot(base(), 'sun7', 'evaluation', { divisionId: '8U' });
    s = {
      ...s,
      practices: [{
        id: 'ev1', divisionId: '8U', slotId: 'sun7',
        teamIds: ['8U-1', '8U-2'], kind: 'evaluation' as const,
      }],
    };
    expect(iceDifferences(s)[0]!.onTheIce).toBe('evaluation: 8U 1, 8U 2');
  });

  it('is empty when nothing has been repurposed', () => {
    expect(iceDifferences(base())).toEqual([]);
  });
});
