import type { PubmedFormula } from '@/lib/search-formula-md';
import { diagnoseStructure, diagnoseNarrowing, diagnosisTargets, queryWithoutBlock, meshOccurrences, diagnosePrecedenceMixing, blockDiagnosisLines } from './blockDiagnosis';

const approved = [{ id: '1', label: '疾患' }, { id: '2', label: '治療' }];
function formula(a = '"Parent"[Mesh]', b = '"Child"[Mesh]', combination = '#1 AND #2 AND #filter'): PubmedFormula {
  return { blocks: [{ id: '1', expression: a, isCombination: false }, { id: '2', expression: b, isCombination: false },
    { id: 'filter', expression: '"Parent"[Mesh]', isCombination: false },
    { id: 'final', expression: combination, isCombination: true }], combinationExpression: combination };
}
const trees = new Map([['parent', ['C01']], ['child', ['C01.100']]]);

test('同一 descriptor は explode の有無を問わず共有として検出する', () => {
  expect(diagnoseStructure(formula('"Parent"[Mesh:NoExp]', '"parent"[Mesh]'), approved, trees).overlaps)
    .toEqual([expect.objectContaining({ blockIds: ['1', '2'], kind: 'same', qualified: false })]);
});
test.each([['Mesh', 1], ['Mesh:NoExp', 0]])('上位語のタグ %s に応じて内包を判定する', (tag, count) => {
  expect(diagnoseStructure(formula(`"Parent"[${tag}]`), approved, trees).overlaps).toHaveLength(count);
  expect(diagnoseStructure(formula(), approved, trees).overlaps[0]?.note).toContain('#1 の "Parent"[Mesh] は #2');
});
test('逆向きの祖先と完全一致でない tree number の区切りを判定する', () => {
  expect(diagnoseStructure(formula('"Child"[Mesh]', '"Parent"[Mesh]'), approved, trees).overlaps[0]?.kind).toBe('ancestor');
  expect(diagnoseStructure(formula(), approved, new Map([['parent', ['C01']], ['child', ['C010']]] )).overlaps).toEqual([]);
  expect(diagnoseStructure(formula(), approved, new Map([['parent', ['C01']], ['child', ['C01']]] )).overlaps).toEqual([]);
});
test.each(['x[tiab] NOT "Parent"[Mesh]', 'x[tiab] NOT ("Parent"[Mesh] OR ("Child"[Mesh]))'])('NOT 側は共有から除外する: %s', (expression) => {
  expect(diagnoseStructure(formula(expression), approved, trees).overlaps).toEqual([]);
});
test('同じ descriptor の NOT 側と肯定側を集約しない', () => {
  const occurrences = meshOccurrences('x[tiab] NOT ("Parent"[Mesh]) OR "Parent"[Mesh:NoExp]');
  expect(occurrences.map((term) => [term.negative, term.explode])).toEqual([[true, true], [false, false]]);
  expect(diagnoseStructure(formula('x[tiab] NOT ("Parent"[Mesh]) OR "Parent"[Mesh:NoExp]'), approved, trees).overlaps).toEqual([]);
});
test.each(['"Parent/drug therapy"[Mesh]', '"Parent"[majr]', '"Parent"[mesh major topic]'])('修飾を残し descriptor の階層で判定する: %s', (text) => {
  expect(diagnoseStructure(formula(text), approved, trees).overlaps[0]).toMatchObject({ kind: 'ancestor', qualified: true, terms: [{ blockId: '1', text }, { blockId: '2', text: '"Child"[Mesh]' }] });
});
test('階層不明を重なりなしにしない', () => {
  expect(diagnoseStructure(formula(), approved, new Map()).overlaps).toEqual([{
    blockIds: ['1', '2'], kind: 'unknown', qualified: false,
    terms: [{ blockId: '1', text: '"Parent"[Mesh]' }, { blockId: '2', text: '"Child"[Mesh]' }],
    note: '#1 と #2: 未判定: 階層を取得できなかった（"Parent"[Mesh]: 階層不明、"Child"[Mesh]: 階層不明）',
  }]);
});

test('階層不明の３語と４語をペア内で重複なくブロック順・出現順にまとめる', () => {
  const xs = ['"A"[Mesh]', '"B"[Mesh]', '"C"[Mesh]'];
  const ys = ['"D"[Mesh]', '"E"[Mesh]', '"F"[Mesh]', '"G/drug therapy"[Mesh]'];
  const reasons = new Map([['a', '通信失敗'], ['g', '通信上限']]);
  expect(diagnoseStructure(formula(xs.join(' OR '), ys.join(' OR ')), approved, new Map(), reasons).overlaps).toEqual([{
    blockIds: ['1', '2'], kind: 'unknown', qualified: true,
    terms: [...xs.map((text) => ({ blockId: '1', text })), ...ys.map((text) => ({ blockId: '2', text }))],
    note: '#1 と #2: 未判定: 階層を取得できなかった（"A"[Mesh]: 通信失敗、"B"[Mesh]: 階層不明、"C"[Mesh]: 階層不明、"D"[Mesh]: 階層不明、"E"[Mesh]: 階層不明、"F"[Mesh]: 階層不明、"G/drug therapy"[Mesh]: 通信上限）',
  }]);
});

test('３ブロックの階層がすべて不明でも未判定は３ペア分にまとめる', () => {
  const f = formula('"A"[Mesh] OR "B"[Mesh]', '"C"[Mesh] OR "D"[Mesh]');
  const rows = diagnoseStructure(f, [...approved, { id: 'filter', label: '追加' }], new Map()).overlaps;
  expect(rows.map((row) => [row.blockIds, row.kind, row.terms.length])).toEqual([
    [['1', '2'], 'unknown', 4], [['1', 'filter'], 'unknown', 3], [['2', 'filter'], 'unknown', 3],
  ]);
});

test('階層不明でも同一 descriptor の組み合わせは共有だけに含める', () => {
  const rows = diagnoseStructure(formula('"Parent"[Mesh]', '"parent"[Mesh:NoExp]'), approved, new Map()).overlaps;
  expect(rows).toEqual([expect.objectContaining({ kind: 'same', terms: [
    { blockId: '1', text: '"Parent"[Mesh]' }, { blockId: '2', text: '"parent"[Mesh:NoExp]' },
  ] })]);
  expect(rows.filter((row) => row.kind === 'unknown').flatMap((row) => row.terms)).toEqual([]);
});

test('共有と内包は組み合わせごとに残し、階層を取得できなかった出現だけを未判定に含める', () => {
  const rows = diagnoseStructure(formula('"Parent"[majr] OR "Child"[Mesh]', '"Parent"[Mesh] OR "Missing"[Mesh]'), approved, trees).overlaps;
  expect(rows.map((row) => row.kind)).toEqual(['same', 'ancestor', 'unknown']);
  expect(rows[2]).toMatchObject({ qualified: false, terms: [{ blockId: '2', text: '"Missing"[Mesh]' }] });
});

test('未判定の説明は先頭１０件と残数を示し、出現と修飾は全件保持する', () => {
  const xs = Array.from({ length: 6 }, (_, i) => `"A${i}"[Mesh]`);
  const ys = [...Array.from({ length: 5 }, (_, i) => `"B${i}"[Mesh]`), '"Last"[majr]'];
  const rows = diagnoseStructure(formula(xs.join(' OR '), ys.join(' OR ')), approved, new Map()).overlaps;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ kind: 'unknown', qualified: true,
    terms: [...xs.map((text) => ({ blockId: '1', text })), ...ys.map((text) => ({ blockId: '2', text }))],
    note: `#1 と #2: 未判定: 階層を取得できなかった（${[...xs, ...ys].slice(0, 10).map((text) => `${text}: 階層不明`).join('、')}、ほか 2 件）`,
  });
});
test.each(['#1 OR #2', '#1 NOT #2', '(#1 AND #2)'])('単純な AND 以外は全体を未判定にする: %s', (expression) => {
  expect(diagnoseStructure(formula(undefined, undefined, expression), approved, trees)).toEqual({ overlaps: [], note: '未判定: 結合式が単純な AND ではない' });
});
test('結合ブロックなしは未判定、承認外ブロックは診断対象外', () => {
  const f = formula();
  expect(diagnosisTargets(f, approved).blocks.map((block) => block.id)).toEqual(['1', '2']);
  f.blocks.pop();
  expect(diagnoseStructure(f, approved, trees).note).toContain('未判定');
});
test('対象の項だけを取り除きフィルタと最後の単一参照も残す', () => {
  const f = formula();
  expect(queryWithoutBlock(f, ['1', '2', 'filter'], '1')).toBe('("Child"[Mesh]) AND ("Parent"[Mesh])');
  expect(queryWithoutBlock(f, ['1', 'filter'], '1')).toBe('("Parent"[Mesh])');
  expect(queryWithoutBlock(f, ['1'], '1')).toBeNull();
});
// 閾値 0.13 は凍結 C0 の削減率分布の切れ目（9.8%〜17.0%）で校正した値（issue #164）。
// 0.19 は初期値 0.2 のときは「絞り込みに効いていない」だったが、切れ目の上側の密集
// （17.0〜17.3%）に属する側なので今は検出しない。ちょうど 0.13 も含めない。
test.each([[88, 100, 0.12, true], [87, 100, 0.13, false], [81, 100, 0.19, false], [70, 100, 0.3, false]])('削減率と閾値: %i / %i', (q, without, reduction, ineffective) => {
  expect(diagnoseNarrowing(approved[0]!, q as number, without as number)).toMatchObject({ reduction, ineffective });
});
test.each([[null, 100, ''], [80, null, '未判定: 測定失敗'], [80, 0, ''], [80, 79, '']])('件数が不確かな場合は未判定: %s / %s', (q, without, failure) => {
  expect(diagnoseNarrowing(approved[0]!, q as number | null, without as number | null, failure as string)).toMatchObject({ reduction: null, ineffective: null, note: expect.stringContaining('未判定') });
});

test('承認済み概念ブロックの優先順位混在を検出し、note に ID とラベルを含める（issue #202）', () => {
  const f = formula('a[tiab] OR b[tiab] AND c[tiab]', '"Child"[Mesh]');
  const precedence = diagnosePrecedenceMixing(f, approved);
  expect(precedence).toEqual([{ blockId: '1', label: '疾患', note: expect.stringContaining('#1 疾患') }]);
  expect(precedence[0]!.note).toContain('AND / NOT と OR');
});
test('混在の無い式・承認外ブロック・結合ブロックは対象にしない', () => {
  expect(diagnosePrecedenceMixing(formula(), approved)).toEqual([]);
  // filter は approved に含まれないため、混在があっても対象外
  const f = formula();
  f.blocks[2]!.expression = 'x[tiab] OR y[tiab] AND z[tiab]';
  expect(diagnosePrecedenceMixing(f, approved)).toEqual([]);
});
test('優先順位混在は結合式が単純な AND でなくても診断する（diagnoseStructure と独立）', () => {
  const f = formula('a[tiab] OR b[tiab] AND c[tiab]', '"Child"[Mesh]', '#1 OR #2');
  expect(diagnoseStructure(f, approved, trees).note).toBe('未判定: 結合式が単純な AND ではない');
  expect(diagnosePrecedenceMixing(f, approved)).toHaveLength(1);
});
test('blockDiagnosisLines は note の直後に優先順位混在の行を出す', () => {
  const lines = blockDiagnosisLines({
    fingerprint: 'x', note: '未判定: 結合式が単純な AND ではない', overlaps: [], narrowing: [],
    precedence: [{ blockId: '1', label: '疾患', note: '#1 疾患: 混在しています' }],
  });
  expect(lines).toEqual(['未判定: 結合式が単純な AND ではない', '#1 疾患: 混在しています']);
});
test('blockDiagnosisLines は precedence の無い旧形式を空扱いで読める', () => {
  expect(blockDiagnosisLines({ fingerprint: 'x', note: '', overlaps: [], narrowing: [] })).toEqual([]);
});
