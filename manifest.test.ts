import { describe, it, expect } from 'vitest';
import { manifestFor, MANIFESTS, HOUSE_LEAGUE, ADULT_LEAGUE, MIDDLE_SCHOOL_LEAGUE } from '@league/core';

describe('league manifests', () => {
  it('covers all three leagues', () => {
    expect(Object.keys(MANIFESTS).sort()).toEqual(['adult', 'house', 'middle_school']);
  });

  it('expresses the practice difference as data', () => {
    expect(HOUSE_LEAGUE.capabilities.practices).toBe(true);
    expect(ADULT_LEAGUE.capabilities.practices).toBe(false);
    expect(MIDDLE_SCHOOL_LEAGUE.capabilities.practices).toBe(false);
  });

  it('keeps the adult league off Friday and Saturday', () => {
    expect(ADULT_LEAGUE.scheduling.blockedWeekdays).toEqual(['friday', 'saturday']);
    expect(HOUSE_LEAGUE.scheduling.blockedWeekdays).toEqual([]);
  });

  it('declares what we still do not know about middle school', () => {
    expect(MIDDLE_SCHOOL_LEAGUE.unknowns.length).toBeGreaterThan(0);
    expect(HOUSE_LEAGUE.unknowns).toEqual([]);
  });

  it('refuses an unknown league instead of defaulting', () => {
    expect(() => manifestFor('beer-league')).toThrow(/Unknown league/);
  });
});
