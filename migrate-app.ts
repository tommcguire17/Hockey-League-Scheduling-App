/** CLI: npx tsx tools/js/migrate-app.ts <app-export.json> <leagueId> <out.season.json> */
import { readFileSync, writeFileSync } from 'node:fs';
import { importAppState, saveSeason } from '@league/io';
import { manifestFor, validateSeason, summarize } from '@league/core';

const [inPath, leagueId, out] = process.argv.slice(2) as [string, string, string];
const { season, issues } = importAppState(readFileSync(inPath, 'utf8'), { leagueId });
writeFileSync(out, saveSeason(season));

console.log(`${season.name}  ->  ${out}`);
console.log(`  ${season.divisions.length} divisions, ${season.teams.length} teams, ` +
  `${season.slots.length} slots, ${season.startDate} .. ${season.endDate}`);
for (const d of season.divisions) {
  const n = season.teams.filter((t) => t.divisionId === d.id).length;
  console.log(`    ${d.name}: ${n} teams, games target ${d.gamesPerTeam ?? 'league default'}`);
}
for (const i of issues.slice(0, 10)) console.log(`  issue: ${i.message}`);
if (issues.length > 10) console.log(`  ...and ${issues.length - 10} more`);

const r = validateSeason(season, manifestFor(leagueId));
console.log(`\nvalidation: ${r.errorCount} errors, ${r.warningCount} warnings`);
for (const s of summarize(r)) console.log(`  ${s.severity.toUpperCase().padEnd(8)} ${s.code.padEnd(26)} ${s.count}`);
