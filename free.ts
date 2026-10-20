import { readFileSync } from 'node:fs';
import { loadSeason } from '@league/io';
const s = loadSeason(readFileSync('data/msu-2026-27.season.json', 'utf8'));
const used = new Map<string, string[]>();
for (const g of s.games) if (g.slotId) (used.get(g.slotId) ?? used.set(g.slotId, []).get(g.slotId)!)
  .push(`${g.divisionId} ${g.homeTeamId ?? g.homeLabel} v ${g.awayTeamId ?? g.awayLabel} [${g.type}]`);
for (const p of s.practices) (used.get(p.slotId) ?? used.set(p.slotId, []).get(p.slotId)!)
  .push(`PRACTICE ${p.divisionId} x${p.teamIds.length}`);

console.log('=== GAME slots with spare capacity, 2027-02-20 onward ===');
for (const sl of s.slots.filter((x) => x.use === 'game' && x.date >= '2027-02-20')) {
  const u = used.get(sl.id) ?? [];
  const free = sl.capacity - u.length;
  console.log(`${sl.date} ${sl.start} ${sl.rink.padEnd(9)} cap${sl.capacity} ${free > 0 ? `FREE x${free}` : '      '}  ${u.join(' | ')}`);
}
console.log('\n=== all 12U games from 2027-02-20 ===');
const slot = new Map(s.slots.map((x) => [x.id, x]));
for (const g of s.games.filter((g) => g.divisionId === '12U' && g.slotId && slot.get(g.slotId)!.date >= '2027-02-20')
  .sort((a, b) => slot.get(a.slotId!)!.date.localeCompare(slot.get(b.slotId!)!.date))) {
  const sl = slot.get(g.slotId!)!;
  console.log(`${sl.date} ${sl.start} ${sl.rink.padEnd(9)} ${g.type.padEnd(10)} ${g.homeTeamId ?? g.homeLabel} v ${g.awayTeamId ?? g.awayLabel}`);
}
console.log('\n=== every division last regular game vs first playoff ===');
for (const d of s.divisions) {
  const ds = s.games.filter((g) => g.divisionId === d.id && g.slotId);
  const reg = ds.filter((g) => g.type === 'regular').map((g) => slot.get(g.slotId!)!.date).sort();
  const po = ds.filter((g) => g.type !== 'regular').map((g) => slot.get(g.slotId!)!.date).sort();
  console.log(`${d.id.padEnd(4)} last regular ${reg.at(-1)}   first playoff ${po[0]}  ${po[0]! <= reg.at(-1)! ? '<-- OVERLAP' : 'ok'}`);
}
