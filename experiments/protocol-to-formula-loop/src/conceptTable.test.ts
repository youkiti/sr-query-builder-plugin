/** @jest-environment node */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildFormulaMd, inspectTable, rowQueries, type ConceptTable } from './conceptTable';
import { classifyLine, requiredUnits } from './formulaUnits';
import { validateFormulaMd } from './submission';
import { rowContextQueries } from './conceptTable';

const row = () => ({ kind: 'specific' as const, label: '名称', mesh: ['Heading'], terms: ['word'] });
const concept = () => ({ name: '概念名', rows: [row()] });
const table = (): ConceptTable => ({ concepts: [concept()] });
const inspect = (value: unknown) => inspectTable(JSON.stringify(value));

test.each([null, 1, false, [], {}])('件数超過の理由は文字列以外を拒否する: %j', (largeResultReason) => {
  expect(inspect({ ...table(), largeResultReason }).report.blocking).toEqual(['表: largeResultReason は文字列にしてください']);
});
test.each([undefined, '', '  ', '適格な研究を落とすため'])('件数超過の理由を受け付け、式には含めない: %j', (largeResultReason) => {
  const value = { ...table(), largeResultReason };
  expect(inspect(value).report.blocking).toEqual([]);
  expect(buildFormulaMd(value)).toBe(buildFormulaMd(table()));
});
test('行の寄与を測る式は、他の概念の全行を括弧で束ねる', () => {
  const value: ConceptTable = { concepts: [concept(), { name: '別の概念', rows: [
    { ...row(), mesh: [], terms: ['alpha', 'beta'] }, { ...row(), mesh: [], terms: ['gamma'] },
  ] }] };
  expect(rowContextQueries(value)).toEqual([
    { concept: 1, row: 1, query: '("Heading"[Mesh] OR word[tiab]) AND (alpha[tiab] OR beta[tiab] OR gamma[tiab])' },
    { concept: 2, row: 1, query: '(alpha[tiab] OR beta[tiab]) AND ("Heading"[Mesh] OR word[tiab])' },
    { concept: 2, row: 2, query: '(gamma[tiab]) AND ("Heading"[Mesh] OR word[tiab])' },
  ]);
});
test('概念１個でフィルタがなければ行そのものの式を返す', () => {
  expect(rowContextQueries(table())).toEqual([{ concept: 1, row: 1, query: rowQueries(table())[0]!.query }]);
});
test.each([false, true])('概念１個でも年代と RCT フィルタ全体を括弧で囲む: %j', (rctFilter) => {
  const value = { ...table(), rctFilter, dateRange: { from: '2000', to: '2020' } };
  const rct = '(randomized controlled trial[pt] OR controlled clinical trial[pt] OR randomized[tiab] OR placebo[tiab] OR drug therapy[sh] OR randomly[tiab] OR trial[tiab] OR groups[tiab]) NOT (animals[mh] NOT (humans[mh] AND animals[mh]))';
  expect(rowContextQueries(value)[0]!.query).toBe('("Heading"[Mesh] OR word[tiab])' + (rctFilter ? ` AND (${rct})` : '') + ' AND (("2000"[dp] : "2020"[dp]))');
});
test('件数を見直す手順書の例は、そのまま検査に通る', () => {
  const procedure = readFileSync(join(__dirname, '../harness/v13/procedure.md'), 'utf8');
  const examples = [...procedure.matchAll(/```json\s*\n([\s\S]*?)```/g)];
  expect(examples).toHaveLength(1);
  expect(inspectTable(examples[0]![1]!).report.blocking).toEqual([]);
});

test.each(['{', 'null', '[]', '1'])('JSON と最上位の形を検査する: %s', (text) => {
  expect(inspectTable(text).report.blocking.length).toBeGreaterThan(0);
  expect(inspectTable(text).table).toBeNull();
});
test.each([
  { ...table(), extra: true }, { concepts: [{ ...concept(), extra: true }] },
  { concepts: [{ ...concept(), rows: [{ ...row(), extra: true }] }] },
  { concepts: [{ ...concept(), rows: [{ ...row(), terms: [{ all: [['word'], ['term']], extra: true }] }] }] },
  { concepts: null }, { concepts: [] }, { concepts: Array(4).fill(concept()) },
  { concepts: Array(3).fill(concept()), thirdConceptReason: '  ' },
  { concepts: [null] }, { concepts: [{ ...concept(), name: ' ' }] }, { concepts: [{ ...concept(), name: 1 }] },
  { concepts: [{ ...concept(), rows: null }] }, { concepts: [{ ...concept(), rows: [] }] }, { concepts: [{ ...concept(), rows: Array(81).fill(row()) }] },
  { concepts: [{ ...concept(), rows: [{ ...row(), kind: 'other' }] }] },
  { concepts: [{ ...concept(), rows: [{ ...row(), label: ' ' }] }] },
  { concepts: [{ ...concept(), rows: [{ ...row(), mesh: null }] }] },
  { concepts: [{ ...concept(), rows: [{ ...row(), terms: null }] }] },
  { concepts: [{ ...concept(), rows: [{ ...row(), terms: Array(31).fill('word') }] }] },
  { concepts: [{ ...concept(), rows: [{ ...row(), mesh: [], terms: [] }] }] },
  { concepts: [{ ...concept(), rows: [{ ...row(), kind: 'general' }] }] },
  { ...table(), rctFilter: 'false' }, { ...table(), dateRange: {} },
  { ...table(), dateRange: { from: '2020', to: '2000' } }, { ...table(), dateRange: { from: 2000, to: '2020' } },
  { ...table(), dateRange: { from: '200', to: '2020' } }, { ...table(), dateRange: { from: '2000', to: '2020', extra: true } },
])('表の不正な形を拒否して単一行の理由を返す: %j', (value) => {
  const result = inspect(value);
  expect(result.table).toBeNull();
  expect(result.report.blocking.length).toBeGreaterThan(0);
  expect(result.report.blocking.every((line) => !/[\r\n]/.test(line))).toBe(true);
});
test.each(['', ' ', 1, null, 'a"b', 'a[b', 'a]b'])('MeSH の不正な値に概念と行を示す: %j', (heading) => {
  const result = inspect({ concepts: [{ ...concept(), rows: [{ ...row(), mesh: [heading] }] }] });
  expect(result.report.blocking[0]).toContain('概念 1（概念名） 行 1（名称）');
});
test.each(['', ' ', 3, null, 'a"b', 'a(b', 'a)b', 'a[b', 'a]b', 'a:b', 'a AND b', 'or', 'Not', 'wo*rd', 'abc*', 'word**',
  { all: null }, { all: [['word']] }, { all: Array(4).fill(['word']) }, { all: [[], ['word']] },
  { all: ['word', ['term']] }, { all: [[{ all: [['word'], ['term']] }], ['term']] }, { all: [['abc*'], ['term']] },
])('不正な語と語の組を拒否する: %j', (term) => {
  expect(inspect({ concepts: [{ ...concept(), rows: [{ ...row(), terms: [term] }] }] }).report.blocking.length).toBeGreaterThan(0);
});
test('省略値と上限の境界を受け付け、不要な第３概念の理由は無視する', () => {
  expect(inspect({ concepts: Array(3).fill(concept()) }).report.blocking).toEqual(['概念 3（概念名）: thirdConceptReason に 3 個目が必要な理由を書いてください']);
  expect(inspect({ ...table(), thirdConceptReason: { ignored: true } }).report.blocking).toEqual([]);
  expect(inspect({ concepts: Array(3).fill(concept()), thirdConceptReason: '必要' }).report.blocking).toEqual([]);
  expect(inspect({ concepts: [{ name: '名前', rows: Array(80).fill({ ...row(), kind: 'general', terms: Array(30).fill('word*') }), noSpecificReason: '単独' }] }).report.blocking).toEqual([]);
});
test('不合格でも数を返し、語句・語尾・重複の気づきを概念ごとに返す', () => {
  const value = { concepts: [{ name: '名前', rows: [{ kind: 'general', label: '総称', mesh: ['Heading'], terms: ['alpha therapy', 'THERAPY', 'therapy', 'disease', 'disea*'] }] }] };
  const result = inspect(value);
  expect(result.report.blocking).toHaveLength(1);
  expect(result.report.notes).toEqual([
    '概念 1（名前）: 総称の行 1、個別の名称の行 0、MeSH 1、語 5',
    expect.stringContaining('alpha therapy — 語順が入れ替わる・間に語が入る書き方は拾えません。語の組でも書くことを考えてください'),
    expect.stringContaining('複数形や派生形を拾うなら語幹に * を付けてください'),
    expect.stringContaining('重複している語: therapy'),
  ]);
  expect(result.report.notes[2]).not.toContain('disease');
});
test('語の組があれば語句の注意を抑え、組の中の語尾と重複も調べる', () => {
  const value: ConceptTable = { concepts: [{ ...concept(), rows: [{ ...row(), terms: ['alpha therapy', { all: [['therapy'], ['THERAPY', 'word']] }] }] }] };
  const notes = inspect(value).report.notes.join('\n');
  expect(notes).not.toContain('語順');
  expect(notes).toContain('語幹に *');
  expect(notes).toContain('重複している語');
});
test('気づきに並べる語はそれぞれ１０個までにする', () => {
  const phrases = Array.from({ length: 12 }, (_, i) => `word${i} therapy`);
  const notes = inspect({ concepts: [{ ...concept(), rows: [{ ...row(), terms: [...phrases, ...phrases] }] }] }).report.notes.slice(1);
  expect(notes).toHaveLength(3);
  for (const note of notes) { expect(note).toContain('word9 therapy'); expect(note).not.toContain('word10 therapy'); }
});
test('語・語句・語の組・MeSH を行順に組み、概念内の重複を除く', () => {
  const value: ConceptTable = { concepts: [{ ...concept(), rows: [
    { ...row(), terms: [' word ', 'stem*', ' two   words ', { all: [['alpha', 'beta*'], ['gamma delta']] }] },
    { ...row(), terms: ['WORD', 'other'] },
  ] }] };
  const query = '"Heading"[Mesh] OR word[tiab] OR stem*[tiab] OR "two words"[tiab] OR ((alpha[tiab] OR beta*[tiab]) AND ("gamma delta"[tiab])) OR other[tiab]';
  expect(buildFormulaMd(value)).toBe('## PubMed/MEDLINE\n\n```\n#1 ' + query + '\n#2 #1\n```\n');
  expect(rowQueries(value)[1]).toEqual({ concept: 1, row: 2, label: '名称', kind: 'specific', query: '"Heading"[Mesh] OR WORD[tiab] OR other[tiab]' });
});
test.each([1, 2, 3])('概念 %i 個と各フィルタの組合せが既存の検査と単位分解を通る', (count) => {
  for (const rctFilter of [false, true]) for (const dateRange of [null, { from: '2000', to: '2020' }]) {
    const value = { concepts: Array(count).fill(concept()), thirdConceptReason: '必要', rctFilter, dateRange };
    expect(inspect(value).report.blocking).toEqual([]);
    const md = buildFormulaMd(value);
    const validated = validateFormulaMd(md);
    expect(validated.ok).toBe(true);
    if (!validated.ok) throw new Error('式の検査に失敗しました');
    expect(requiredUnits(validated.formula)).toMatchObject({ undetermined: false });
    expect(requiredUnits(validated.formula).units).toHaveLength(count + Number(rctFilter) + Number(!!dateRange));
    const filters = validated.formula.blocks.filter((block) => ['Date', 'RCTfilter'].includes(block.id));
    expect(filters.every((block) => classifyLine(block) === 'filter')).toBe(true);
    if (dateRange) expect(md).toContain('#Date ("2000"[dp] : "2020"[dp])');
    if (rctFilter) expect(md).toContain('#RCTfilter (randomized controlled trial[pt] OR controlled clinical trial[pt] OR randomized[tiab] OR placebo[tiab] OR drug therapy[sh] OR randomly[tiab] OR trial[tiab] OR groups[tiab]) NOT (animals[mh] NOT (humans[mh] AND animals[mh]))');
  }
});
test('手順書の例は、そのまま検査に通る', () => {
  const procedure = readFileSync(join(__dirname, '../harness/v11/procedure.md'), 'utf8');
  const examples = [...procedure.matchAll(/```json\s*\n([\s\S]*?)```/g)];
  expect(examples).toHaveLength(1);
  expect(inspectTable(examples[0]![1]!).report.blocking).toEqual([]);
});
test('語と MeSH に # は書けず、MeSH だけの行は気づきとして返す', () => {
  expect(inspect({ concepts: [{ ...concept(), rows: [{ ...row(), terms: ['word #1'] }] }] }).report.blocking).toEqual([expect.stringContaining('記号や演算子')]);
  expect(inspect({ concepts: [{ ...concept(), rows: [{ ...row(), mesh: ['#1'] }] }] }).report.blocking).toEqual([expect.stringContaining('MeSH は')]);
  const result = inspect({ concepts: [{ ...concept(), rows: [{ ...row(), terms: [] }, row()] }] });
  expect(result.report.blocking).toEqual([]);
  expect(result.report.notes).toContainEqual('概念 1（概念名）: 行 1（名称） — MeSH だけで語がありません。MeSH がまだ付いていない論文は拾えません');
});
