import { diversify, narrowExpression, outsideQueries } from './outsideSample';
import type { RequiredUnit } from './formulaUnits';

test.each([
  ['tiab', 'ti'], ['Title/Abstract', 'ti'], ['TW', 'ti'], ['Text Word', 'ti'],
  ['TIAB:~12', 'ti:~12'], ['Title/Abstract:~2', 'ti:~2'],
  ['Mesh', 'majr'], ['MH', 'majr'], ['MeSH Terms', 'majr'],
  ['Mesh:NoExp', 'majr:noexp'], ['mh:noexp', 'majr:noexp'], ['MeSH Terms:NoExp', 'majr:noexp'],
  ['ti', 'ti'], ['majr', 'majr'], ['pt', 'pt'], ['sh', 'sh'], ['nm', 'nm'], ['tiab:~x', 'tiab:~x'],
])('タグ %s を指定どおりに書き換える', (from, to) => {
  expect(narrowExpression(`word[${from}]`)).toBe(`word[${to}]`);
});
test('引用符の内側とタグなしの語を保持する', () => {
  expect(narrowExpression('"a[tiab] b[Mesh]"[Title/Abstract] OR plain')).toBe('"a[tiab] b[Mesh]"[ti] OR plain');
});
const unit = (id: string, expression: string, negative = false): RequiredUnit => ({ id, expression, negative });
test('外側の式の順序を保ち、対象以外の肯定の概念だけを絞る', () => {
  const units = [unit('1', 'a[tiab]'), unit('2', 'b[Mesh]'), unit('3', 'c[tiab] OR trial[pt]'), unit('4', 'd[tiab]', true)];
  expect(outsideQueries(units, '1', 'bundle')).toEqual({
    current: '(b[Mesh]) AND (c[tiab] OR trial[pt]) NOT (d[tiab]) NOT (a[tiab])',
    narrowed: '((b[majr]) AND (b[Mesh])) AND (c[tiab] OR trial[pt]) NOT (d[tiab]) NOT (a[tiab])',
    narrowedBeyondBundle: '((b[majr]) AND (b[Mesh])) AND (c[tiab] OR trial[pt]) NOT (d[tiab]) NOT (a[tiab]) NOT (bundle)',
  });
});
test('概念内の否定を含む絞り込みを元の集合と交差させる', () => {
  const result = outsideQueries([unit('1', 'beta[tiab]'), unit('2', 'alpha[tiab] NOT excluded[tiab]')], '1', 'bundle');
  const narrowed = '((alpha[ti] NOT excluded[ti]) AND (alpha[tiab] NOT excluded[tiab])) NOT (beta[tiab])';
  expect(result?.narrowed).toBe(narrowed);
  expect(result?.narrowedBeyondBundle).toBe(narrowed + ' NOT (bundle)');
});
test('対象なし・否定・他の肯定なし・他の概念なしは対象外にする', () => {
  expect(outsideQueries([unit('1', 'a')], '2', 'b')).toBeNull();
  expect(outsideQueries([unit('1', 'a', true), unit('2', 'b')], '1', 'b')).toBeNull();
  expect(outsideQueries([unit('1', 'a'), unit('2', 'b', true)], '1', 'b')).toBeNull();
  expect(outsideQueries([unit('1', 'a'), unit('2', 'trial[pt]')], '1', 'b')).toBeNull();
});
test('新しい見出しを優先し、未付与を含む残りを関連度順に補う', () => {
  const candidates = [[], ['A'], ['A'], ['A', 'B'], ['B'], ['C']].map((majorHeadings, i) => ({ pmid: String(i), majorHeadings }));
  expect(diversify(candidates, 3)).toEqual(['1', '3', '5']);
  expect(diversify(candidates, 5)).toEqual(['1', '3', '5', '0', '2']);
  expect(diversify(candidates, 9)).toEqual(['1', '3', '5', '0', '2', '4']);
  expect(diversify(candidates, 0)).toEqual([]);
  expect(diversify([], 15)).toEqual([]);
});
