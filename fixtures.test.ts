import { describe, it, expect } from 'vitest';
import { buildFixtures, meetingCounts, roundRobin, regularGraph, FixtureError } from '@league/engine';

const counts = (fs: ReturnType<typeof buildFixtures>) => {
  const c = new Map<string, number>();
  for (const f of fs) {
    c.set(f.homeId, (c.get(f.homeId) ?? 0) + 1);
    c.set(f.awayId, (c.get(f.awayId) ?? 0) + 1);
  }
  return c;
};
const ids = (n: number, p = 'T') => Array.from({ length: n }, (_, i) => `${p}${i + 1}`);

describe('round robin', () => {
  it('pairs every team exactly once per round', () => {
    const rs = roundRobin(ids(8));
    expect(rs.length).toBe(7);
    for (const r of rs) {
      expect(r.length).toBe(4);
      expect(new Set(r.flat()).size).toBe(8);
    }
  });
  it('gives an odd division a bye each round', () => {
    const rs = roundRobin(ids(7));
    expect(rs.length).toBe(7); // 7 teams + a bye = 8, so 7 rounds
    for (const r of rs) expect(r.length).toBe(3);
  });
});

describe('regular graph', () => {
  it('builds a 3-regular graph on 8 vertices', () => {
    const e = regularGraph(8, 3);
    expect(e.length).toBe(12);
    const deg = new Array(8).fill(0);
    for (const [a, b] of e) { deg[a]++; deg[b]++; }
    expect(deg).toEqual(new Array(8).fill(3));
  });
  it('refuses an impossible degree instead of returning something wrong', () => {
    expect(() => regularGraph(7, 3)).toThrow(FixtureError);
  });
});

describe('buildFixtures', () => {
  it('gives the 8-team Lower division exactly 10 games each', () => {
    const fs = buildFixtures(ids(8, 'L'), 10);
    expect(fs.length).toBe(40);
    expect([...counts(fs).values()]).toEqual(new Array(8).fill(10));
  });

  it('gives the 6-team Upper division a perfect double round robin', () => {
    const fs = buildFixtures(ids(6, 'U'), 10);
    expect(fs.length).toBe(30);
    expect([...counts(fs).values()]).toEqual(new Array(6).fill(10));
    // every pair exactly twice
    expect([...meetingCounts(fs).values()]).toEqual(new Array(15).fill(2));
  });

  it('spreads the 8-team extras so no pair meets three times', () => {
    const m = meetingCounts(buildFixtures(ids(8, 'L'), 10));
    const vals = [...m.values()].sort();
    expect(Math.max(...vals)).toBe(2);
    expect(vals.filter((v) => v === 2).length).toBe(12); // the 3-regular extras
    expect(vals.filter((v) => v === 1).length).toBe(16);
  });

  it('gives every team an exactly even home and away split', () => {
    for (const n of [6, 8]) {
      const fs = buildFixtures(ids(n), 10);
      const home = new Map<string, number>();
      for (const f of fs) home.set(f.homeId, (home.get(f.homeId) ?? 0) + 1);
      const v = [...home.values()];
      expect(Math.max(...v)).toBe(5);
      expect(Math.min(...v)).toBe(5);
    }
  });

  it('refuses an odd number of team-games rather than silently dropping one', () => {
    expect(() => buildFixtures(ids(7), 9)).toThrow(FixtureError);
  });

  it('is deterministic', () => {
    expect(buildFixtures(ids(8), 10)).toEqual(buildFixtures(ids(8), 10));
  });
});
