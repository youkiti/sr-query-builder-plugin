export interface TableReport { blocking: string[]; notes: string[] }
export type TableTerm = string | { all: string[][] };
export interface ConceptRow { kind: 'general' | 'specific'; label: string; mesh: string[]; terms: TableTerm[] }
export interface ConceptTable {
  concepts: { name: string; rows: ConceptRow[]; noSpecificReason?: string }[];
  thirdConceptReason?: string; largeResultReason?: string; rctFilter?: boolean; dateRange?: { from: string; to: string } | null;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const normalized = (text: string): string => text.trim().replace(/\s+/g, ' ');
const unique = (items: string[]): string[] => [...new Map(items.map((item) => [item.toLowerCase(), item])).values()];

export function inspectTable(text: string): { report: TableReport; table: ConceptTable | null } {
  const report: TableReport = { blocking: [], notes: [] };
  const bad = (where: string, message: string) => { report.blocking.push(`${where}: ${message}`.replace(/[\r\n]+/g, ' ')); };
  const keys = (value: Record<string, unknown>, allowed: string[], where: string) => {
    for (const key of Object.keys(value)) if (!allowed.includes(key)) bad(where, `知らないキーがあります（${key}）`);
  };
  const term = (value: unknown, where: string) => {
    if (!nonempty(value)) { bad(where, '語は空でない文字列にしてください'); return; }
    const words = value.trim().split(/\s+/);
    if (/["()[\]:#]/.test(value) || words.some((word) => /^(AND|OR|NOT)$/i.test(word))) bad(where, '語に検索式の記号や演算子は書けません');
    if (words.some((word) => word.includes('*') && (!/^[^*]+\*$/.test(word) || [...word.slice(0, -1)].length < 4))) bad(where, '* は各語の末尾だけに、語幹を 4 文字以上にして付けてください');
  };
  let value: unknown;
  try { value = JSON.parse(text); } catch { bad('表', 'JSON として読めません'); return { report, table: null }; }
  if (!object(value)) { bad('表', '最上位はオブジェクトにしてください'); return { report, table: null }; }
  keys(value, ['concepts', 'thirdConceptReason', 'largeResultReason', 'rctFilter', 'dateRange'], '表');
  if (value.largeResultReason !== undefined && typeof value.largeResultReason !== 'string') bad('表', 'largeResultReason は文字列にしてください');
  if (!Array.isArray(value.concepts) || value.concepts.length < 1 || value.concepts.length > 3) bad('表', 'concepts は 1〜3 個の配列にしてください');
  if (value.rctFilter !== undefined && typeof value.rctFilter !== 'boolean') bad('表', 'rctFilter は真偽値にしてください');
  if (value.dateRange !== undefined && value.dateRange !== null) {
    const date = value.dateRange;
    if (object(date)) keys(date, ['from', 'to'], '年代');
    if (!object(date) || typeof date.from !== 'string' || typeof date.to !== 'string'
      || !/^\d{4}$/.test(date.from) || !/^\d{4}$/.test(date.to) || date.from > date.to) bad('表', 'dateRange は null または from ≤ to の西暦 4 桁の範囲にしてください');
  }
  if (Array.isArray(value.concepts)) value.concepts.forEach((concept: unknown, i: number) => {
    const where = `概念 ${i + 1}（${object(concept) && typeof concept.name === 'string' ? normalized(concept.name) : '名前なし'}）`;
    if (!object(concept)) { bad(where, '概念はオブジェクトにしてください'); return; }
    if (i === 2 && Array.isArray(value.concepts) && value.concepts.length === 3 && !nonempty(value.thirdConceptReason)) bad(where, 'thirdConceptReason に 3 個目が必要な理由を書いてください');
    keys(concept, ['name', 'rows', 'noSpecificReason'], where);
    if (!nonempty(concept.name)) bad(where, 'name は空でない文字列にしてください');
    if (concept.noSpecificReason !== undefined && typeof concept.noSpecificReason !== 'string') bad(where, 'noSpecificReason は文字列にしてください');
    if (!Array.isArray(concept.rows)) { bad(where, 'rows は配列にしてください'); return; }
    if (!concept.rows.length || concept.rows.length > 80) bad(where, 'rows は 1〜80 行にしてください');
    let general = 0, specific = 0, mesh = 0, terms = 0, grouped = false;
    const strings: string[] = [], phrases: string[] = [], meshOnly: string[] = [];
    concept.rows.forEach((row: unknown, j: number) => {
      const place = `${where} 行 ${j + 1}（${object(row) && typeof row.label === 'string' ? normalized(row.label) : 'ラベルなし'}）`;
      if (!object(row)) { bad(place, '行はオブジェクトにしてください'); return; }
      keys(row, ['kind', 'label', 'mesh', 'terms'], place);
      if (row.kind === 'general') general++; else if (row.kind === 'specific') specific++; else bad(place, 'kind は general または specific にしてください');
      if (!nonempty(row.label)) bad(place, 'label は空でない文字列にしてください');
      if (!Array.isArray(row.mesh)) bad(place, 'mesh は配列にしてください');
      else { mesh += row.mesh.length; for (const heading of row.mesh) if (!nonempty(heading) || /["[\]#]/.test(heading)) bad(place, 'MeSH は空でない文字列とし、引用符・角括弧・# は書けません'); }
      if (!Array.isArray(row.terms)) bad(place, 'terms は配列にしてください');
      else {
        terms += row.terms.length;
        if (row.terms.length > 30) bad(place, 'terms は 30 個以下にしてください');
        for (const item of row.terms) {
          if (typeof item === 'string') { term(item, place); strings.push(normalized(item)); if (/\s/.test(item.trim())) phrases.push(normalized(item)); }
          else if (object(item)) {
            grouped = true;
            keys(item, ['all'], place);
            if (!Array.isArray(item.all)) bad(place, '語の組の all は配列にしてください');
            else {
              if (item.all.length < 2 || item.all.length > 3) bad(place, '語の組は 2〜3 類にしてください');
              for (const group of item.all) {
                if (!Array.isArray(group) || !group.length) bad(place, '語の類は空でない配列にしてください');
                else for (const word of group) { term(word, place); if (typeof word === 'string') strings.push(normalized(word)); }
              }
            }
          } else term(item, place);
        }
      }
      if (Array.isArray(row.mesh) && Array.isArray(row.terms) && !row.mesh.length && !row.terms.length) bad(place, 'MeSH も語も無い行です');
      if (Array.isArray(row.mesh) && Array.isArray(row.terms) && row.mesh.length && !row.terms.length) meshOnly.push(`行 ${j + 1}（${typeof row.label === 'string' ? normalized(row.label) : 'ラベルなし'}）`);
    });
    if (!specific && !nonempty(concept.noSpecificReason)) bad(where, '個別の名称の行も、無い理由も書かれていません');
    report.notes.push(`${where}: 総称の行 ${general}、個別の名称の行 ${specific}、MeSH ${mesh}、語 ${terms}`);
    if (phrases.length && !grouped) report.notes.push(`${where}: ${unique(phrases).slice(0, 10).join('、')} — 語順が入れ替わる・間に語が入る書き方は拾えません。語の組でも書くことを考えてください`);
    const stems = strings.flatMap((word) => word.toLowerCase().split(' ')).filter((word) => word.endsWith('*'));
    const unstemmed = strings.filter((word) => {
      const last = word.split(' ').pop()!;
      return /^[a-z]{6,}$/i.test(last) && !stems.some((stem) => stem.startsWith(last.slice(0, 5).toLowerCase()));
    });
    if (unstemmed.length) report.notes.push(`${where}: ${unique(unstemmed).slice(0, 10).join('、')} — 複数形や派生形を拾うなら語幹に * を付けてください`);
    if (meshOnly.length) report.notes.push(`${where}: ${meshOnly.slice(0, 10).join('、')} — MeSH だけで語がありません。MeSH がまだ付いていない論文は拾えません`);
    const seen = new Set<string>();
    const duplicates = strings.filter((word) => { const key = word.toLowerCase(); if (seen.has(key)) return true; seen.add(key); return false; });
    if (duplicates.length) report.notes.push(`${where}: 重複している語: ${unique(duplicates).slice(0, 10).join('、')}`);
  });
  return { report, table: report.blocking.length ? null : value as unknown as ConceptTable };
}

const wordQuery = (word: string): string => { const text = normalized(word); return `${text.includes(' ') ? `"${text}"` : text}[tiab]`; };
const rowItems = (row: ConceptRow): string[] => [...row.mesh.map((heading) => `"${normalized(heading)}"[Mesh]`),
  ...row.terms.map((term) => typeof term === 'string' ? wordQuery(term) : `(${term.all.map((group) => `(${group.map(wordQuery).join(' OR ')})`).join(' AND ')})`)];
const firstUnique = (items: string[]): string[] => { const seen = new Set<string>(); return items.filter((item) => { const key = item.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; }); };
export function rowQueries(table: ConceptTable): { concept: number; row: number; label: string; kind: 'general' | 'specific'; query: string }[] {
  return table.concepts.flatMap((concept, i) => concept.rows.map((row, j) => ({ concept: i + 1, row: j + 1, label: row.label, kind: row.kind, query: firstUnique(rowItems(row)).join(' OR ') })));
}
const rctQuery = '(randomized controlled trial[pt] OR controlled clinical trial[pt] OR randomized[tiab] OR placebo[tiab] OR drug therapy[sh] OR randomly[tiab] OR trial[tiab] OR groups[tiab]) NOT (animals[mh] NOT (humans[mh] AND animals[mh]))';
const dateQuery = (date: NonNullable<ConceptTable['dateRange']>): string => `("${date.from}"[dp] : "${date.to}"[dp])`;
export function rowContextQueries(table: ConceptTable): { concept: number; row: number; query: string }[] {
  const concepts = table.concepts.map((concept) => firstUnique(concept.rows.flatMap(rowItems)).join(' OR '));
  const filters = [...(table.rctFilter ? [rctQuery] : []), ...(table.dateRange ? [dateQuery(table.dateRange)] : [])];
  return rowQueries(table).map(({ concept, row, query }) => {
    const others = [...concepts.filter((_, i) => i !== concept - 1), ...filters];
    return { concept, row, query: others.length ? [query, ...others].map((part) => `(${part})`).join(' AND ') : query };
  });
}
export function buildFormulaMd(table: ConceptTable): string {
  const lines = table.concepts.map((concept, i) => `#${i + 1} ${firstUnique(concept.rows.flatMap(rowItems)).join(' OR ')}`);
  const refs = table.concepts.map((_, i) => `#${i + 1}`);
  if (table.rctFilter) {
    lines.push(`#RCTfilter ${rctQuery}`);
    refs.push('#RCTfilter');
  }
  if (table.dateRange) { lines.push(`#Date ${dateQuery(table.dateRange)}`); refs.push('#Date'); }
  lines.push(`#${table.concepts.length + 1} ${refs.join(' AND ')}`);
  return '## PubMed/MEDLINE\n\n```\n' + lines.join('\n') + '\n```\n';
}
