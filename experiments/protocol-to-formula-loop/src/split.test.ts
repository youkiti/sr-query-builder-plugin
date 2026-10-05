/** @jest-environment node */
import { createHash } from 'node:crypto';
import { CASES } from '../../query-optimization-bench/types';
import { SPLIT_SALT, splitKey, splitReviews } from './split';
import { review } from './testFixtures';

test('空文字と接尾辞を除いた空白だけのキーは PMCID に戻し、互いに重複しない', () => {
  const rows = ['', '  ', '  .pub2'].map((cochrane_id, i) => ({ ...review(i + 1), cochrane_id }));
  for (const row of rows) expect(splitKey(row)).toBe(row.pmcid);
  expect(splitReviews(rows).size).toBe(3);
  expect(splitKey({ ...review(), cochrane_id: ' CD000001 .pub2 ' })).toBe('CD000001');
});

test('null は PMCID を用い、版の接尾辞を取り除き、重複キーを拒否する', () => {
  expect(splitKey({ ...review(), cochrane_id: null })).toBe(review().pmcid);
  expect(splitKey({ ...review(), cochrane_id: 'CD000001.pub2' })).toBe('CD000001');
  expect(() => splitReviews([review(), { ...review(2), cochrane_id: 'CD000001.pub2' }])).toThrow('重複');
});
test('ティアごとの丸めた境界とハッシュ順に従い、入力順に依存しない', () => {
  const rows = Array.from({ length: 14 }, (_, i) => ({ ...review(i + 1), tier: i < 7 ? 'cc-by' as const : 'cc-by-nc' as const,
    cochrane_id: i === 0 ? null : review(i + 1).cochrane_id }));
  const result = splitReviews(rows);
  for (const tier of ['cc-by', 'cc-by-nc']) {
    const ordered = rows.filter((row) => row.tier === tier).sort((a, b) => {
      const hash = (key: string) => createHash('sha256').update(`${SPLIT_SALT}:${key}`).digest('hex');
      return hash(splitKey(a)).localeCompare(hash(splitKey(b)));
    });
    expect(ordered.map((row) => result.get(row.pmcid))).toEqual(['development', 'validation', 'validation', 'validation', 'test', 'test', 'test']);
  }
  expect(splitReviews([...rows].reverse())).toEqual(result);
});
test('既存の全4件を開発群に上書きし、他の割り当てを動かさない', () => {
  const rows = Array.from({ length: 20 }, (_, i) => review(i + 1));
  const before = splitReviews(rows);
  const pinned = rows.map((row, i) => ({ ...row, pmcid: CASES[i]?.pmcid ?? row.pmcid }));
  const after = splitReviews(pinned);
  for (const entry of CASES) expect(after.get(entry.pmcid)).toBe('development');
  for (const row of rows.slice(CASES.length)) expect(after.get(row.pmcid)).toBe(before.get(row.pmcid));
});
