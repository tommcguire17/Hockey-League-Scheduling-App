import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { importIceSlots, useFromEventType, divisionFromEventType } from '@league/io';

/** The header row Finnly actually writes. */
const H = 'Event Day,Event Date,Event Type,Event Start Time,Event End Time,Facility Name';
const row = (type: string, start: string, end: string) =>
  `Wed,12/2/2026,${type},${start},${end},Red Hawk Rink`;
/** One row per type, each an hour later, so none is read as a duplicate booking. */
const file = (...types: string[]) =>
  [H, ...types.map((t, i) => row(t, `${4 + i}:10 PM`, `${5 + i}:10 PM`))].join('\n');

describe('reading the Event Type', () => {
  it('tells games, practices and evaluations apart', () => {
    expect(useFromEventType('YHL Game')).toBe('game');
    expect(useFromEventType('YHL Practice')).toBe('practice');
    expect(useFromEventType('YHL Evaluations - u10')).toBe('evaluation');
  });

  it('reads an evaluation as an evaluation even when it also says practice', () => {
    expect(useFromEventType('Evaluation practice skate')).toBe('evaluation');
  });

  it('takes the words a rink actually uses', () => {
    expect(useFromEventType('House Scrimmage')).toBe('game');
    // Playoff ice is its own use now: a game sheet the regular season may
    // not have, which is the whole reason the rink writes it on the booking.
    expect(useFromEventType('Playoff - Semifinal')).toBe('playoff');
    expect(useFromEventType('Championship Game')).toBe('playoff');
    expect(useFromEventType('House Game')).toBe('game');
    expect(useFromEventType('Skills Clinic')).toBe('practice');
    expect(useFromEventType('Power Skating')).toBe('practice');
    expect(useFromEventType('Open Ice')).toBe('unused');
  });

  it('says nothing rather than guessing', () => {
    expect(useFromEventType('Private Rental')).toBe(null);
    expect(useFromEventType('   ')).toBe(null);
  });

  it('finds the division named inside the type', () => {
    const divs = ['8U', '10U', '12U', '15U'];
    expect(divisionFromEventType('YHL Evaluations - u10', divs)).toBe('10U');
    expect(divisionFromEventType('YHL Evaluations - U15', divs)).toBe('15U');
    expect(divisionFromEventType('YHL Game', divs)).toBe(null);
    // and does not let a short id swallow a longer one
    expect(divisionFromEventType('u15 practice', ['U1', 'U15'])).toBe('U15');
  });
});

describe('importing ice', () => {
  it('no longer calls every slot a game', () => {
    const r = importIceSlots(file('YHL Game', 'YHL Practice', 'YHL Evaluations - u12'),
      { divisionIds: ['10U', '12U'] });
    expect(r.items.map((s) => s.use).sort()).toEqual(['evaluation', 'game', 'practice']);
  });

  it('gives an evaluation slot to the division it names, and never releases it', () => {
    const r = importIceSlots(file('YHL Evaluations - u12'), { divisionIds: ['10U', '12U'] });
    const [s] = r.items;
    expect(s!.ownerDivisionId).toBe('12U');
    expect(s!.ownerPolicy).toBe('exclusive');
  });

  it('leaves practice capacity on auto so a whole age group fits', () => {
    const r = importIceSlots(file('YHL Practice'));
    expect(r.items[0]!.practiceTeams).toBe(0);
  });

  it('says so when it cannot read a type, instead of quietly calling it a game', () => {
    const r = importIceSlots(file('Private Rental', 'Private Rental'));
    expect(r.items.every((s) => s.use === 'game')).toBe(true);
    expect(r.issues.some((i) => /Private Rental/.test(i.message))).toBe(true);
    expect(r.issues.some((i) => /2 slots/.test(i.message))).toBe(true);
  });

  it('falls back to the caller default when there is no type column', () => {
    const csv = 'Date,Start,End,Rink\n12/2/2026,6:10 PM,7:10 PM,Red Hawk';
    expect(importIceSlots(csv, { defaultUse: 'practice' }).items[0]!.use).toBe('practice');
  });

  it('reads the real House export as 113 games, 78 practices and 5 evaluations', () => {
    const csv = readRealExport();
    if (!csv) return;                       // the file is gitignored data
    const r = importIceSlots(csv, { divisionIds: ['8U', '10U', '12U', '15U'] });
    const n = (u: string) => r.items.filter((s) => s.use === u).length;
    expect(r.items.length).toBe(196);
    expect(n('game')).toBe(113);
    expect(n('practice')).toBe(78);
    expect(n('evaluation')).toBe(5);
    expect(r.skipped).toBe(0);
  });
});

/** The real export is Tom's data and is not in the repo; skip when absent. */
function readRealExport(): string | null {
  try {
    return readFileSync('/mnt/user-data/outputs/2026-27-house-ice-slots.csv', 'utf8');
  } catch { return null; }
}
