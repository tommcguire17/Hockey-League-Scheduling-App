import { describe, it, expect } from 'vitest';
import { parseCsv, toCsv, Header } from '@league/io';
import { normalizeRink, normalizeDate, normalizeTime, normalizeJerseyNumber } from '@league/io';

describe('csv', () => {
  it('handles quotes, commas, CRLF and a BOM', () => {
    const t = '﻿a,b\r\n"x,1","he said ""hi"""\r\n';
    expect(parseCsv(t)).toEqual([['a', 'b'], ['x,1', 'he said "hi"']]);
  });
  it('round-trips through toCsv', () => {
    const rows = [['a', 'b'], ['x,1', 'q"q']];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });
  it('names the missing column instead of returning undefined', () => {
    const h = new Header(['Date', 'Start'], 'Test');
    expect(h.find('date')).toBe(0);
    expect(() => h.require('Facility')).toThrow(/no column matching "Facility"/);
  });
});

describe('normalizers', () => {
  it('collapses the rink naming that broke the by-rink totals', () => {
    expect(normalizeRink('Rocky Rink')).toBe('Rocky');
    expect(normalizeRink('Red Hawk Rink')).toBe('Red Hawk');
    expect(normalizeRink('  Rocky ')).toBe('Rocky');
    expect(normalizeRink('Red Hawk')).toBe('Red Hawk');
  });
  it('accepts every date shape these exports produce', () => {
    expect(normalizeDate('2026-12-05')).toBe('2026-12-05');
    expect(normalizeDate('12/5/2026')).toBe('2026-12-05');
    expect(normalizeDate('12/5/26')).toBe('2026-12-05');
    expect(normalizeDate('46361')).toBe('2026-12-05'); // Excel serial
    expect(normalizeDate('')).toBeNull();
  });
  it('accepts every time shape', () => {
    expect(normalizeTime('07:00')).toBe('07:00');
    expect(normalizeTime('7:00 AM')).toBe('07:00');
    expect(normalizeTime('7:40:00 PM')).toBe('19:40');
    expect(normalizeTime('12:00 AM')).toBe('00:00');
    expect(normalizeTime('12:30 PM')).toBe('12:30');
    expect(normalizeTime('nonsense')).toBeNull();
  });
  it('rejects out-of-range jersey numbers rather than passing them through', () => {
    expect(normalizeJerseyNumber('#29')).toBe(29);
    expect(normalizeJerseyNumber(29)).toBe(29);
    expect(normalizeJerseyNumber('No preference')).toBeNull();
    expect(normalizeJerseyNumber('99')).toBeNull();  // cap is 98
    expect(normalizeJerseyNumber('0')).toBeNull();   // floor is 1
    expect(normalizeJerseyNumber('00')).toBeNull();
    expect(normalizeJerseyNumber(null)).toBeNull();
  });
});
