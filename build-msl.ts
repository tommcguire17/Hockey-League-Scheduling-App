/** CLI: npx tsx tools/js/build-msl.ts <ice.csv> <teams.csv> <out.json> */
import { readFileSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { importIceSlots, importTeams, importBlackouts, saveSeason } from '@league/io';
import { Season, manifestFor, validateSeason, summarize } from '@league/core';

const [icePath, teamsPath, out, blackoutPath] = process.argv.slice(2) as
  [string, string, string, string | undefined];
const ice = importIceSlots(readFileSync(icePath, 'utf8'), { idPrefix: 'msl', defaultUse: 'game' });
const tm = importTeams(readFileSync(teamsPath, 'utf8'));
const bo = blackoutPath && existsSync(blackoutPath)
  ? importBlackouts(readFileSync(blackoutPath, 'utf8'))
  : { dates: [] as string[], reasons: new Map<string, string>(), issues: [] };

const dates = ice.items.map((s) => s.date).sort();
const season = Season.parse({
  id: 'msl-2026-27', name: 'MSU Middle School League 2026-27', leagueId: 'middle_school',
  startDate: dates[0], endDate: dates.at(-1),
  venue: 'Montclair State University Ice Arena', city: 'Little Falls',
  blackoutDates: bo.dates,
  divisions: tm.divisions.map((d) => ({ ...d, gamesPerTeam: 10, practicesPerTeam: 0 })),
  teams: tm.teams, slots: ice.items, games: [], practices: [], people: [],
});
writeFileSync(out, saveSeason(season));

console.log(`ICE   ${ice.items.length} slots, ${ice.skipped} skipped, ${ice.issues.length} issues`);
console.log(`TEAMS ${tm.teams.length} teams in ${tm.divisions.length} divisions`);
for (const d of tm.divisions) {
  const n = tm.teams.filter((t) => t.divisionId === d.id);
  console.log(`  ${d.name} (${n.length}): ${n.map((t) => t.name).join(', ')}`);
}
for (const i of [...ice.issues, ...tm.issues, ...bo.issues]) console.log(`  issue: ${i.message}`);
if (bo.dates.length) {
  const lost = ice.items.filter((s) => bo.dates.includes(s.date)).length;
  console.log(`BLACKOUT ${bo.dates.length} dates, removing ${lost} slots from play`);
  for (const d of bo.dates) console.log(`  ${d}${bo.reasons.get(d) ? '  ' + bo.reasons.get(d) : ''}`);
} else {
  console.log('BLACKOUT none set — put dates in the blackout CSV and rebuild');
}
console.log(`\nwrote ${out}  ${season.startDate} .. ${season.endDate}`);

const r = validateSeason(season, manifestFor(season.leagueId));
console.log(`\nvalidation: ${r.errorCount} errors, ${r.warningCount} warnings`);
for (const s of summarize(r)) console.log(`  ${s.severity.toUpperCase().padEnd(8)} ${s.code.padEnd(26)} ${s.count}`);
