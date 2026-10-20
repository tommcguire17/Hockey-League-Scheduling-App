/**
 * RFC 4180 CSV, no dependency. Handles quoted fields, embedded commas,
 * doubled quotes, CRLF and a UTF-8 BOM, because every real export has at
 * least one of these.
 */
export function parseCsv(text: string): string[][] {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const push = () => { row.push(field); field = ''; };
  const endRow = () => { push(); rows.push(row); row = []; };
  while (i < s.length) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { quoted = true; i++; continue; }
    if (c === ',') { push(); i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { endRow(); i++; continue; }
    field += c; i++;
  }
  if (field.length || row.length) endRow();
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

export function toCsv(rows: (string | number | null | undefined)[][], eol = '\r\n'): string {
  const cell = (x: string | number | null | undefined) => {
    const v = x === null || x === undefined ? '' : String(x);
    return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  return rows.map((r) => r.map(cell).join(',')).join(eol) + eol;
}

/** Case- and whitespace-insensitive header lookup, so a renamed column is a
 *  clear error rather than a silent undefined. */
export class Header {
  private idx = new Map<string, number>();
  constructor(private readonly cells: string[], private readonly label: string) {
    cells.forEach((c, i) => this.idx.set(norm(c), i));
  }
  /** First matching alias, or -1. */
  find(...aliases: string[]): number {
    for (const a of aliases) {
      const i = this.idx.get(norm(a));
      if (i !== undefined) return i;
    }
    return -1;
  }
  require(...aliases: string[]): number {
    const i = this.find(...aliases);
    if (i < 0) {
      throw new Error(
        `${this.label}: no column matching ${aliases.map((a) => `"${a}"`).join(' / ')}. ` +
          `Columns present: ${this.cells.join(' | ')}`,
      );
    }
    return i;
  }
}
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
