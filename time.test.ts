import { describe, it, expect } from 'vitest';
import { weekdayOf, weekKey, bandOf, daysBetween, fmtTime, fmtTimeRange } from '@league/core';

describe('clock times as a parent reads them', () => {
  it('turns the 24-hour clock into AM and PM', () => {
    // The one Tom named: 18:30 was showing as 18:30.
    expect(fmtTime('18:30')).toBe('6:30 PM');
    expect(fmtTime('07:00')).toBe('7:00 AM');
    expect(fmtTime('13:40')).toBe('1:40 PM');
    expect(fmtTime('09:05')).toBe('9:05 AM');
  });

  it('gets midnight and midday the right way round', () => {
    // 12 AM and 12 PM are where naive hour % 12 produces "0 AM".
    expect(fmtTime('00:00')).toBe('12:00 AM');
    expect(fmtTime('00:30')).toBe('12:30 AM');
    expect(fmtTime('12:00')).toBe('12:00 PM');
    expect(fmtTime('12:45')).toBe('12:45 PM');
    expect(fmtTime('11:59')).toBe('11:59 AM');
    expect(fmtTime('23:59')).toBe('11:59 PM');
  });

  it('always shows minutes, so a column of times lines up', () => {
    expect(fmtTime('19:00')).toBe('7:00 PM');
    expect(fmtTime('7:00')).toBe('7:00 AM');
  });

  it('hands back nonsense unchanged rather than inventing a time', () => {
    expect(fmtTime('')).toBe('');
    expect(fmtTime('TBD')).toBe('TBD');
    expect(fmtTime('25:00')).toBe('25:00');
    expect(fmtTime('18:99')).toBe('18:99');
  });

  it('reads a slot as a range, wrapping past midnight', () => {
    expect(fmtTimeRange('18:30', 80)).toBe('6:30 PM–7:50 PM');
    expect(fmtTimeRange('23:30', 60)).toBe('11:30 PM–12:30 AM');
  });
});

describe('calendar maths', () => {
  it('reads weekdays without timezone drift', () => {
    expect(weekdayOf('2026-12-05')).toBe('saturday');
    expect(weekdayOf('2026-12-06')).toBe('sunday');
    expect(weekdayOf('2027-03-21')).toBe('sunday');
  });

  it('groups a weekend together for a Monday-start league', () => {
    // Sat 12/05 and Sun 12/06 are the SAME week when weeks start Monday.
    expect(weekKey('2026-12-05', 'monday')).toBe(weekKey('2026-12-06', 'monday'));
  });

  it('splits that same weekend for a Sunday-start league', () => {
    // and DIFFERENT weeks when weeks start Sunday. This single difference is
    // why House and Adult need separate manifests.
    expect(weekKey('2026-12-05', 'sunday')).not.toBe(weekKey('2026-12-06', 'sunday'));
  });

  it('bands times at the boundaries', () => {
    const b = { morningBefore: '12:00', eveningFrom: '17:00' };
    expect(bandOf('11:59', b)).toBe('morning');
    expect(bandOf('12:00', b)).toBe('midday');
    expect(bandOf('16:59', b)).toBe('midday');
    expect(bandOf('17:00', b)).toBe('evening');
  });

  it('counts days across a month and a year boundary', () => {
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1);
    expect(daysBetween('2026-12-05', '2027-03-21')).toBe(106);
  });
});
