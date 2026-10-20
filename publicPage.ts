import type { Season, LeagueManifest } from '@league/core';
import {
  bracketProgress, bracketRounds, codeOfGameId, fmtLongDate, fmtTime, gameWhen, isPlayed,
  playoffGames, REASON_LABELS, ROUND_LABELS, standings,
} from '@league/core';

/**
 * A single self-contained HTML file: the schedule, results and standings for
 * one season. No scripts from anywhere else, no player data, no spreadsheet.
 * Post it on the association site, email it, print it.
 */
export function publicPage(season: Season, m: LeagueManifest): string {
  const slot = new Map(season.slots.map((s) => [s.id, s]));
  const name = new Map(season.teams.map((t) => [t.id, t.name]));
  const who = (id: string | null, label: string) => esc(id ? name.get(id) ?? id : label);

  /**
   * Everything a family would come here to look up, not only games. An
   * evaluation skate run on a slot the building booked as a game is still an
   * evaluation to the parent reading this page, so it is labelled as one.
   */
  type Entry = {
    date: string; start: string; rink: string; away: boolean;
    kind: 'game' | 'practice' | 'evaluation';
    divisionId: string; teams: string[]; what: string; score: string;
    gameId: string | null; type: string;
  };

  const entries: Entry[] = [];
  for (const g of season.games) {
    const w = gameWhen(g, slot);
    if (!w) continue;
    entries.push({
      date: w.date, start: w.start, rink: w.rink, away: w.away, kind: 'game',
      divisionId: g.divisionId,
      teams: [g.homeTeamId, g.awayTeamId].filter(Boolean) as string[],
      what: `${who(g.homeTeamId, g.homeLabel)} <span class="v">v</span> ${who(g.awayTeamId, g.awayLabel)}`,
      score: isPlayed(g) ? `${g.homeGoals}&ndash;${g.awayGoals}` : '',
      gameId: g.id, type: g.type,
    });
  }
  for (const p of season.practices) {
    const s = slot.get(p.slotId);
    if (!s) continue;
    const names = p.teamIds.map((t) => esc(name.get(t) ?? t)).join(', ');
    entries.push({
      date: s.date, start: s.start, rink: s.rink, away: false,
      kind: p.kind === 'evaluation' ? 'evaluation' : 'practice',
      divisionId: p.divisionId, teams: p.teamIds,
      what: `<span class="lbl ${p.kind}">${p.kind === 'evaluation' ? 'Evaluation' : 'Practice'}</span> ${names}`,
      score: '', gameId: null, type: p.kind,
    });
  }
  entries.sort((a, b) => (a.date + a.start + a.rink).localeCompare(b.date + b.start + b.rink));

  const moved = new Set(season.changes.map((c) => c.gameId));
  const table = standings(season, m);
  const divisions = season.divisions.filter((d) => season.teams.some((t) => t.divisionId === d.id));

  const byDate = new Map<string, Entry[]>();
  for (const x of entries) (byDate.get(x.date) ?? byDate.set(x.date, []).get(x.date)!).push(x);

  const rows = [...byDate.entries()].map(([date, list]) => `
      <tr class="daybreak"><th colspan="6">${esc(fmtLongDate(date))}</th></tr>
      ${list.map((e) => `<tr class="k-${e.kind}" data-kind="${e.kind}" data-div="${esc(e.divisionId)}" data-teams="${esc(e.teams.join(' '))}">
        <td class="t">${esc(fmtTime(e.start))}</td>
        <td class="r">${esc(e.rink)}${e.away ? ' <span class="tag">away</span>' : ''}</td>
        <td class="d"><span class="chip">${esc(divName(e.divisionId))}</span></td>
        <td class="m">${e.what}</td>
        <td class="s">${e.score}</td>
        <td class="n">${e.gameId && moved.has(e.gameId) ? '<span class="tag moved">rescheduled</span>' : ''}</td>
      </tr>`).join('')}`).join('');

  function divName(id: string) {
    return season.divisions.find((d) => d.id === id)?.name ?? id;
  }

  const standingsHtml = !m.capabilities.standings ? '' : divisions.map((d) => {
    const rs = table.filter((r) => r.divisionId === d.id);
    if (!rs.some((r) => r.played)) return '';
    return `<h3>${esc(d.name)}</h3>
    <table class="stand">
      <thead><tr><th>#</th><th>Team</th><th>GP</th><th>W</th><th>L</th><th>T</th>
        <th>Pts</th><th>GF</th><th>GA</th><th>+/-</th><th>Last 5</th></tr></thead>
      <tbody>${rs.map((r) => `<tr>
        <td class="k">${r.rank}</td><td class="tm">${esc(r.teamName)}</td>
        <td>${r.played}</td><td>${r.won}</td><td>${r.lost}</td><td>${r.tied}</td>
        <td class="pts">${r.points}</td><td>${r.goalsFor}</td><td>${r.goalsAgainst}</td>
        <td>${r.diff > 0 ? '+' : ''}${r.diff}</td>
        <td class="form">${r.form.slice(0, 5).map((f) => `<i class="f${f}">${f}</i>`).join('')}</td>
      </tr>`).join('')}</tbody>
    </table>`;
  }).join('');

  const changesHtml = !season.changes.length ? '' : `
    <section>
      <h2>Changes</h2>
      <p class="lede">Every game that has moved since the schedule was published.</p>
      <table class="stand">
        <thead><tr><th>Game</th><th>Was</th><th>Now</th><th>Reason</th></tr></thead>
        <tbody>${season.changes.slice().reverse().map((c) => {
          const g = season.games.find((x) => x.id === c.gameId);
          return `<tr>
            <td class="tm">${g ? `${who(g.homeTeamId, g.homeLabel)} v ${who(g.awayTeamId, g.awayLabel)}` : esc(c.gameId)}</td>
            <td>${esc(place(c.from))}</td><td>${esc(place(c.to))}</td>
            <td>${esc(REASON_LABELS[c.reason])}${c.note ? ` — ${esc(c.note)}` : ''}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>
    </section>`;

  const bracketHtml = !playoffGames(season).length ? '' : divisions.map((d) => {
    const rounds = bracketRounds(season, d.id);
    if (!rounds.length) return '';
    const prog = bracketProgress(season, d.id);
    const cols = rounds.map((round) => `
      <div class="rnd">
        <h4>${esc(ROUND_LABELS[round[0]!.type] ?? 'Round')}</h4>
        ${round.map((g) => {
          const w = gameWhen(g, slot);
          const done = isPlayed(g) && g.homeTeamId && g.awayTeamId;
          const win = done && g.homeGoals !== g.awayGoals
            ? (g.homeGoals! > g.awayGoals! ? g.homeTeamId : g.awayTeamId) : null;
          const row = (id: string | null, label: string, goals: number | null) =>
            `<div class="sd${id && win === id ? ' won' : ''}${id ? '' : ' tbd'}">
              <span>${who(id, label)}</span><b>${goals ?? ''}</b></div>`;
          return `<div class="tie">
            <div class="th"><i>${esc(codeOfGameId(g.id).toUpperCase())}</i>${
              w ? esc(`${fmtLongDate(w.date)} · ${fmtTime(w.start)} · ${w.rink}`) : 'to be scheduled'}</div>
            ${row(g.homeTeamId, g.homeLabel, g.homeGoals)}
            ${row(g.awayTeamId, g.awayLabel, g.awayGoals)}
          </div>`;
        }).join('')}
      </div>`).join('');
    return `<h3>${esc(d.name)}${prog.champion
      ? ` — <span class="champ">${esc(prog.champion)}</span>` : ''}</h3>
      <div class="brk">${cols}</div>`;
  }).join('');

  const teamOptions = season.teams.slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(season.name)} — Schedule</title>
<style>
:root{--sheet:#F2F6F9;--shadow:#DCE6EE;--deep:#C3D3E0;--boards:#16222C;--blue:#1D4E89;
 --red:#C8102E;--wash:#E4F0F9;--ink:#16222C;--soft:#51626F;--faint:#8698A5;--ok:#1B7A4B}
*{box-sizing:border-box}
body{margin:0;background:var(--sheet);color:var(--ink);font:14px/1.5 Archivo,system-ui,sans-serif;
 font-variant-numeric:tabular-nums}
header{background:var(--boards);color:var(--sheet);padding:18px 20px;border-bottom:3px solid var(--red)}
header h1{margin:0;font-size:20px;font-weight:700}
header p{margin:4px 0 0;color:#9FC0DA;font-size:13px}
main{max-width:1000px;margin:0 auto;padding:20px 16px 70px}
h2{font-size:17px;margin:28px 0 4px}
h3{font-size:14px;margin:18px 0 6px;color:var(--blue)}
.lede{color:var(--soft);margin:0 0 12px}
.controls{display:flex;gap:10px;flex-wrap:wrap;margin:14px 0 18px;position:sticky;top:0;
 background:var(--sheet);padding:10px 0;z-index:2;border-bottom:1px solid var(--deep)}
select{font:inherit;padding:6px 8px;border:1px solid var(--deep);border-radius:2px;background:#fff}
table{width:100%;border-collapse:collapse}
th{text-align:left;font-size:12px;color:var(--soft);padding:6px 8px 6px 0;
 border-bottom:2px solid var(--blue);white-space:nowrap}
td{padding:6px 8px 6px 0;border-bottom:1px solid var(--shadow)}
tr.daybreak th{background:var(--wash);color:var(--ink);font-size:13px;font-weight:700;
 padding:8px;border-bottom:1px solid var(--deep);border-top:1px solid var(--deep)}
td.t{width:72px;color:var(--soft)}td.r{width:120px}td.d{width:80px}
td.s{width:66px;font-weight:700;text-align:right}
td.n{width:110px}
.v{color:var(--faint);padding:0 4px}
.chip{display:inline-block;font-size:11px;font-weight:700;padding:2px 6px;border-radius:2px;
 background:var(--wash);color:var(--blue)}
.tag{display:inline-block;font-size:11px;font-weight:700;padding:1px 5px;border-radius:2px;
 background:var(--shadow);color:var(--soft)}
.tag.moved{background:#FBE3E6;color:var(--red)}
.lbl{display:inline-block;font-size:11px;font-weight:700;padding:1px 6px;border-radius:2px;
 margin-right:6px;text-transform:uppercase;letter-spacing:.04em}
.lbl.practice{background:var(--wash);color:var(--blue)}
.lbl.evaluation{background:#A4620A;color:#fff}
tr.k-practice td.m,tr.k-evaluation td.m{color:var(--soft)}
.stand td{padding:5px 8px 5px 0}
.stand td.k{width:28px;color:var(--faint)}.stand td.tm{font-weight:600}
.stand td.pts{font-weight:700}
.form i{display:inline-block;width:17px;height:17px;line-height:17px;text-align:center;
 font-style:normal;font-size:11px;font-weight:700;border-radius:2px;margin-right:2px;color:#fff}
.fW{background:var(--ok)}.fL{background:var(--red)}.fT{background:var(--faint)}
footer{color:var(--faint);font-size:12px;margin-top:34px;border-top:1px solid var(--deep);padding-top:10px}
.brk{display:flex;gap:12px;overflow-x:auto;padding-bottom:4px}
.brk .rnd{flex:1 1 0;min-width:180px;display:flex;flex-direction:column;gap:9px}
.brk .rnd+.rnd{justify-content:center}
.brk h4{margin:0;font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;
 color:var(--faint)}
.brk .tie{border:1px solid var(--deep);border-left:3px solid var(--crease);background:#fff}
.brk .th{display:flex;gap:8px;justify-content:space-between;padding:4px 7px;font-size:11px;
 color:var(--soft);border-bottom:1px solid var(--shadow)}
.brk .th i{font-style:normal;font-weight:700;color:var(--blue)}
.brk .sd{display:flex;justify-content:space-between;gap:8px;padding:5px 7px;
 border-bottom:1px solid var(--shadow)}
.brk .sd:last-child{border-bottom:0}
.brk .sd.tbd span{color:var(--faint);font-style:italic}
.brk .sd.won{background:var(--wash)}.brk .sd.won span{font-weight:700}
.brk .sd b{min-width:1.3em;text-align:right}
.champ{color:var(--ok)}
@media(max-width:620px){.brk{display:block}.brk .rnd{min-width:0;margin-bottom:12px}}
.hide{display:none}
@media(max-width:620px){td.r,td.n{display:none}td.d{width:62px}}
@media print{.controls{display:none}body{background:#fff}}
</style></head>
<body>
<header>
  <h1>${esc(season.name)}</h1>
  <p>${esc(fmtLongDate(season.startDate))} to ${esc(fmtLongDate(season.endDate))}${season.venue ? ` · ${esc(season.venue)}` : ''}</p>
</header>
<main>
  <div class="controls">
    <label>Team <select id="team"><option value="">Everyone</option>${teamOptions}</select></label>
    <label>Division <select id="div"><option value="">All</option>${
      divisions.map((d) => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('')}</select></label>
    <label>Show <select id="kind">
      <option value="">Games and practices</option>
      <option value="game">Games only</option>
      <option value="practice">Practices only</option>
      <option value="evaluation">Evaluations only</option>
    </select></label>
  </div>
  <table id="sched"><tbody>${rows}</tbody></table>
  ${bracketHtml ? `<section><h2>Playoffs</h2>${bracketHtml}</section>` : ''}
  ${standingsHtml ? `<section><h2>Standings</h2>${standingsHtml}</section>` : ''}
  ${changesHtml}
  <footer>Generated ${esc(new Date().toISOString().slice(0, 10))}. Times are local to the rink.</footer>
</main>
<script>
// Filtering only. Nothing is sent anywhere and nothing is loaded from anywhere.
var team=document.getElementById('team'),div=document.getElementById('div'),
    kind=document.getElementById('kind'),
    rows=[].slice.call(document.querySelectorAll('#sched tr'));
function apply(){
  var t=team.value,d=div.value,k=kind.value,lastHead=null;
  rows.forEach(function(r){
    if(r.classList.contains('daybreak')){ r.classList.add('hide'); lastHead=r; return; }
    var ok=(!t||(' '+r.dataset.teams+' ').indexOf(' '+t+' ')>-1)
      &&(!d||r.dataset.div===d)&&(!k||r.dataset.kind===k);
    r.classList.toggle('hide',!ok);
    if(ok&&lastHead){ lastHead.classList.remove('hide'); }
  });
}
team.onchange=div.onchange=kind.onchange=apply;
</script>
</body></html>`;
}

function place(p: { date: string | null; start: string | null; rink: string }): string {
  if (!p.date) return 'not scheduled';
  return `${fmtLongDate(p.date)}, ${p.start ? fmtTime(p.start) : ''}${p.rink ? ` · ${p.rink}` : ''}`;
}

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
