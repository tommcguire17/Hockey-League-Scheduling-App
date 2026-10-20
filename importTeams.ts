import { Team, Division } from '@league/core';
import { parseCsv, Header } from './csv.js';
import { slugify } from './normalize.js';
import type { ImportResult, ImportIssue } from './importIceSlots.js';

export interface TeamImport {
  teams: Team[];
  divisions: Division[];
  issues: ImportIssue[];
  skipped: number;
}

/**
 * Imports a team list. Columns: Team name | Division (aliases accepted).
 * Divisions are derived from the values present, so a new division appears
 * simply by being typed in the sheet.
 */
export function importTeams(csv: string): TeamImport {
  const rows = parseCsv(csv);
  const issues: ImportIssue[] = [];
  if (rows.length < 2) return { teams: [], divisions: [], issues: [{ row: 0, message: 'No data rows.' }], skipped: 0 };

  const h = new Header(rows[0]!, 'Teams');
  const cName = h.require('Team name', 'Team', 'Name');
  const cDiv = h.require('Division', 'Div', 'Conference');

  const teams: Team[] = [];
  const divNames: string[] = [];
  const seen = new Set<string>();
  let skipped = 0;

  for (let r = 1; r < rows.length; r++) {
    const name = (rows[r]![cName] ?? '').trim();
    const div = (rows[r]![cDiv] ?? '').trim();
    if (!name || !div) { skipped++; issues.push({ row: r + 1, message: 'Missing team name or division; row skipped.' }); continue; }
    const id = slugify(name);
    if (seen.has(id)) { skipped++; issues.push({ row: r + 1, message: `Duplicate team "${name}"; row skipped.` }); continue; }
    seen.add(id);
    if (!divNames.includes(div)) divNames.push(div);
    if (/placeholder/i.test(name)) {
      issues.push({ row: r + 1, message: `"${name}" is still a placeholder.` });
    }
    teams.push(Team.parse({ id, divisionId: div, name, coach: '', blackoutDates: [], allowedWeekdays: [] }));
  }
  const divisions = divNames.map((d) =>
    Division.parse({ id: d, name: d, gamesPerTeam: null, practicesPerTeam: 0, playoffTeams: 0 }));
  return { teams, divisions, issues, skipped };
}
