/** CLI: npx tsx tools/js/export.ts <season.json> <out-prefix> */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  loadSeason, exportSportNinja, exportScheduleCsv, exportUnusedIceCsv,
  exportChangesCsv, publicPage, unusedIceSummary,
} from '@league/io';
import { manifestFor } from '@league/core';

const [path, prefix] = process.argv.slice(2) as [string, string];
const s = loadSeason(readFileSync(path, 'utf8'));
const m = manifestFor(s.leagueId);
const games = s.games.filter((g) => g.slotId || g.away).length;
const free = unusedIceSummary(s);

const write = (suffix: string, body: string, note: string) => {
  writeFileSync(`${prefix}-${suffix}`, body);
  console.log(`${`${prefix}-${suffix}`.padEnd(46)} ${note}`);
};
write('schedule.csv', exportScheduleCsv(s), `${games} games`);
write('sportninja.csv', exportSportNinja(s, { venue: s.venue, city: s.city }), `${games} rows`);
write('unused-ice.csv', exportUnusedIceCsv(s), `${free.slots} slots, ${free.hours.toFixed(1)} hours`);
write('schedule.html', publicPage(s, m), 'the page families see');
if (s.changes.length) write('changes.csv', exportChangesCsv(s), `${s.changes.length} moves`);
