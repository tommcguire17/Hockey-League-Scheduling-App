import { Season, Team, Division, Slot, BRACKET_SIZES, isBracketSize, type Weekday } from '@league/core';
import { normalizeRink, normalizeDate, normalizeTime, slugify } from './normalize.js';
import type { ImportIssue } from './importIceSlots.js';

/**
 * Bridge from the standalone HTML schedulers. Both the House and Adult apps
 * keep the same shape in localStorage and export it as JSON, so one importer
 * retires both.
 *
 * Shape: { name, start, end, cap, pcap, playoffTeams, allowDouble, venue, city,
 *          divisions[], teams[], lines[], extras[], closures[], blackouts[] }
 * `extras` are dated slots, `lines` are weekly repeating patterns, and
 * `closures` / `blackouts` remove dates.
 */
export interface AppStateImport { season: Season; issues: ImportIssue[]; }

const DAYS: Weekday[] = [
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
];

export function importAppState(
  json: string, opts: { leagueId: string; seasonId?: string },
): AppStateImport {
  const issues: ImportIssue[] = [];
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(json) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`That is not valid JSON: ${(e as Error).message}`);
  }
  const g = <T>(k: string, d: T): T => (raw[k] === undefined || raw[k] === null ? d : raw[k] as T);
  const arr = (k: string): Record<string, unknown>[] =>
    Array.isArray(raw[k]) ? raw[k] as Record<string, unknown>[] : [];

  const str = (v: unknown, d = '') => (v === undefined || v === null ? d : String(v));
  const num = (v: unknown, d: number) => {
    const n = Number(v);
    return Number.isFinite(n) && String(v).trim() !== '' ? n : d;
  };

  // divisions ---------------------------------------------------------------
  const divisions: Division[] = arr('divisions').map((d) => Division.parse({
    id: str(d.id) || slugify(str(d.name)),
    name: str(d.name) || str(d.id),
    gamesPerTeam: str(d.cap).trim() ? num(d.cap, 0) : null,
    practicesPerTeam: str(d.pcap).trim() ? num(d.pcap, 0) : null,
    playoffTeams: num(g('playoffTeams', 0), 0),
  }));

  // teams -------------------------------------------------------------------
  const parseDays = (v: unknown): Weekday[] => {
    const s = str(v).toLowerCase();
    if (!s.trim()) return [];
    const out: Weekday[] = [];
    for (const d of DAYS) if (s.includes(d.slice(0, 3))) out.push(d);
    return out;
  };
  const teams: Team[] = arr('teams').map((t) => Team.parse({
    id: str(t.id) || slugify(str(t.name)),
    divisionId: str(t.div) || str(t.divisionId),
    name: str(t.name) || str(t.id),
    coach: str(t.coach),
    blackoutDates: String(str(t.blackouts)).split(',')
      .map((x) => normalizeDate(x.trim())).filter((x): x is string => !!x),
    allowedWeekdays: parseDays(t.days),
  }));

  // The old app held ONE playoff count for the whole league and applied it to
  // every division. A division with fewer teams than that cannot seed it, so
  // bring it down to the largest bracket that fits and say so.
  for (const d of divisions) {
    const n = teams.filter((t) => t.divisionId === d.id).length;
    if (d.playoffTeams <= n && isBracketSize(d.playoffTeams)) continue;
    const fit = [...BRACKET_SIZES].reverse().find((s) => s <= Math.min(d.playoffTeams, n)) ?? 0;
    if (fit !== d.playoffTeams) {
      issues.push({
        row: 0,
        message: `${d.name}: ${d.playoffTeams} playoff teams does not fit ${n} teams. `
          + `Set to ${fit || 'none'}. Change it on Playoffs if that is wrong.`,
      });
      d.playoffTeams = fit;
    }
  }

  // slots: dated extras, plus weekly lines expanded across the season --------
  const startDate = normalizeDate(str(g('start', ''))) ?? '';
  const endDate = normalizeDate(str(g('end', ''))) ?? '';
  const useOf = (v: unknown): Slot['use'] => {
    const s = str(v, 'games').toLowerCase();
    if (s.startsWith('prac')) return 'practice';
    if (s.startsWith('unused') || s.startsWith('out')) return 'unused';
    return 'game';
  };
  const slots: Slot[] = [];
  const seen = new Set<string>();
  const push = (date: string, time: string, s: Record<string, unknown>, where: string) => {
    const rink = normalizeRink(str(s.rink)) || 'Unknown';
    const id = `slot-${date}-${time.replace(':', '')}-${rink.replace(/\W+/g, '')}`;
    if (seen.has(id)) { issues.push({ row: 0, message: `${where}: duplicate slot ${date} ${time} ${rink}.` }); return; }
    seen.add(id);
    slots.push(Slot.parse({
      id, date, start: time, minutes: num(s.mins, 60), rink,
      use: useOf(s.use), capacity: Math.max(1, num(s.gamesPer, 1)),
      practiceTeams: Math.max(1, num(s.slotTeams, 1)),
      ownerDivisionId: str(s.pdiv) || null, tag: '',
    }));
  };

  for (const s of arr('extras')) {
    const date = normalizeDate(str(s.date));
    const time = normalizeTime(str(s.time));
    if (!date || !time) { issues.push({ row: 0, message: `Slot with an unreadable date or time skipped: ${JSON.stringify(s).slice(0, 80)}` }); continue; }
    push(date, time, s, 'extras');
  }

  const removed = new Set<string>([...arr('closures'), ...arr('blackouts')]
    .map((c) => normalizeDate(str(c.date ?? c))).filter((x): x is string => !!x));

  for (const line of arr('lines')) {
    const time = normalizeTime(str(line.time));
    const dayName = str(line.day).toLowerCase();
    const idx = DAYS.findIndex((d) => dayName.startsWith(d.slice(0, 3)));
    if (!time || idx < 0 || !startDate || !endDate) {
      issues.push({ row: 0, message: `Weekly line skipped, could not read its day or time: ${JSON.stringify(line).slice(0, 80)}` });
      continue;
    }
    for (let d = new Date(`${startDate}T00:00:00Z`); d <= new Date(`${endDate}T00:00:00Z`);
         d = new Date(d.getTime() + 86400000)) {
      if (d.getUTCDay() !== idx) continue;
      const date = d.toISOString().slice(0, 10);
      if (removed.has(date)) continue;
      push(date, time, line, 'weekly lines');
    }
  }
  slots.sort((a, b) => (a.date + a.start + a.rink).localeCompare(b.date + b.start + b.rink));

  const season = Season.parse({
    id: opts.seasonId ?? slugify(str(g('name', 'season'))),
    name: str(g('name', 'Imported season')),
    leagueId: opts.leagueId,
    startDate, endDate,
    venue: str(g('venue', '')), city: str(g('city', '')),
    blackoutDates: [...removed].sort(),
    divisions, teams, slots, games: [], practices: [], people: [],
  });
  return { season, issues };
}
