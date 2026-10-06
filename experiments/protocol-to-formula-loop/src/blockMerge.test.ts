import { analyzeSource, chooseAssignment, mergedQuery, overlapCoefficient } from './blockMerge';
import { validateFormulaMd } from './submission';

const md = (query: string) => '## PubMed/MEDLINE\n\n```\n#1 ' + query + '\n```\n';
const analyze = (query: string, maxConcepts = 3) => {
  const text = md(query), validated = validateFormulaMd(text);
  if (!validated.ok) throw new Error('合成式が不正です');
  return analyzeSource(text, validated.query, maxConcepts);
};

test('一概念は余裕を問わず、二概念・三概念は入れ替わった対応を選ぶ', () => {
  const options = { minOverlap: 0.3, minMargin: 0.1 };
  expect(chooseAssignment([[0.4]], options)).toEqual({ accepted: true, permutation: [0], score: 0.4, margin: null, minPair: 0.4 });
  expect(chooseAssignment([[0.1, 0.9], [0.8, 0.2]], options)).toMatchObject({ accepted: true, permutation: [1, 0], minPair: 0.8 });
  expect(chooseAssignment([[0, 0, 1], [1, 0, 0], [0, 1, 0]], options)).toMatchObject({ accepted: true, permutation: [2, 0, 1], score: 1 });
  expect(chooseAssignment([[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]], options).accepted).toBe(true);
});
test('最小の組と次点との差で不採用にし、不採用でも最良の値を返す', () => {
  expect(chooseAssignment([[0.2]], { minOverlap: 0.3, minMargin: 1 }).accepted).toBe(false);
  expect(chooseAssignment([[1, 0], [0, 0.2]], { minOverlap: 0.3, minMargin: 0.1 }))
    .toMatchObject({ accepted: false, permutation: [0, 1], minPair: 0.2, score: 0.6 });
  expect(chooseAssignment([[0.8, 0.75], [0.75, 0.8]], { minOverlap: 0.3, minMargin: 0.1 }).accepted).toBe(false);
  expect(chooseAssignment([[1, 1], [1, 1]], { minOverlap: 0.3, minMargin: 0.1 }))
    .toMatchObject({ accepted: false, margin: 0, score: 1 });
  expect(chooseAssignment([[1, 1], [1, 1]], { minOverlap: 0.3, minMargin: 0 }).accepted).toBe(true);
});
test('使えない五種類の理由を区別する', () => {
  expect(analyzeSource('不正', '', 3)).toEqual({ usable: false, reason: 'invalid' });
  expect(analyzeSource(md('a'), 'b', 3)).toEqual({ usable: false, reason: 'query_mismatch' });
  expect(analyze('a OR b')).toEqual({ usable: false, reason: 'undetermined' });
  expect(analyze('english[la]')).toEqual({ usable: false, reason: 'no_concept' });
  expect(analyze('a AND b AND c AND d')).toEqual({ usable: false, reason: 'too_many_concepts' });
});
test('署名は概念数と正規化したフィルタ集合に依存する', () => {
  const a = analyze('a AND Clinical   Trial[pt] AND English[la] NOT animals[mh]');
  const b = analyze('b AND english[la] AND clinical trial[pt] NOT ANIMALS[mh]');
  expect(a.usable && b.usable && a.signature === b.signature).toBe(true);
  const c = analyze('b');
  expect(a.usable && c.usable && a.signature !== c.signature).toBe(true);
  expect(a).toMatchObject({ usable: true, concepts: ['a'], filters: [
    { expression: 'Clinical   Trial[pt]', negative: false }, { expression: 'English[la]', negative: false },
    { expression: 'animals[mh]', negative: true },
  ] });
});
test('概念ごとの和を積にし、肯定の後に否定を置き、重複と完成式を扱う', () => {
  const group = { concepts: [['a', 'b', 'a'], ['c', 'd']], filters: [
    { expression: 'animals[mh]', negative: true }, { expression: 'english[la]', negative: false },
  ] };
  expect(mergedQuery([group, group], ['other', 'other']))
    .toBe('(((a) OR (b)) AND ((c) OR (d)) AND (english[la]) NOT (animals[mh])) OR (other)');
  expect(mergedQuery([], ['a', 'a', 'b'])).toBe('(a) OR (b)');
  expect(mergedQuery([], ['a'])).toBe('(a)');
});
test('件数から重なり係数を求め、矛盾する値を拒否する', () => {
  expect(overlapCoefficient(10, 20, 5)).toBe(0.5);
  expect(overlapCoefficient(0, 10, 0)).toBe(0);
  for (const values of [[1, 2, 2], [-1, 2, 0], [1, -2, 0], [1, 2, -1], [1.5, 2, 1], [1, 2.5, 1], [1, 2, 0.5], [NaN, 2, 0], [1, Infinity, 0]]) {
    expect(() => overlapCoefficient(values[0]!, values[1]!, values[2]!)).toThrow('件数の関係が不正です');
  }
});
