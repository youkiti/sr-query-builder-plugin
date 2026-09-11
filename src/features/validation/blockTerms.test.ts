import {
  collectMeasuredContext, computeSiblingOverlaps, computeSiblingOverlapsFromTerms,
  extractBlockTerms, freewordCacheKey, isExplodeTag, meshHitQuery, spineTreeNumbers,
} from './blockTerms';
import { analyzeFreewordDelta } from './freewordDelta';

test('MeSH の重複は explode を優先し、フリーワードはタグを保持する', () => {
  expect(extractBlockTerms('"A"[Mesh:NoExp] OR "A"[Mesh] OR "B"[mh:noexp] OR x[tiab] OR x[tiab] OR x[tw] OR ""[Mesh]')).toEqual({
    meshTerms: [{ descriptor: 'A', explode: true }, { descriptor: 'B', explode: false }],
    freewordTerms: [{ display: 'x[tiab]', query: 'x[tiab]' }, { display: 'x[tw]', query: 'x[tw]' }],
  });
  expect(extractBlockTerms('"A"[Mesh] OR "A"[Mesh:NoExp]').meshTerms[0]!.explode).toBe(true);
  expect(extractBlockTerms('#1 AND #2')).toEqual({ meshTerms: [], freewordTerms: [] });
  expect(isExplodeTag('A')).toBe(true);
  expect(isExplodeTag('A[mh: noexp]')).toBe(false);
});

test('共有語の種別・順序と、共有語のない兄弟も保持する', () => {
  const expression = '"A"[Mesh] OR x[tiab]';
  const siblings = [
    { id: '2', label: '対象', expression: 'x[tiab] OR "A"[mh] OR y[tw]' },
    { id: '3', label: null, expression: 'x[tw]' },
  ];
  const overlaps = computeSiblingOverlaps(expression, siblings);
  expect(overlaps).toEqual([
    { ...siblings[0], sharedTerms: [{ term: 'A', kind: 'mesh' }, { term: 'x[tiab]', kind: 'freeword' }] },
    { ...siblings[1], sharedTerms: [] },
  ]);
  expect(computeSiblingOverlapsFromTerms(extractBlockTerms(expression), siblings)).toEqual(overlaps);
  expect(computeSiblingOverlaps(expression, [])).toEqual([]);
});

test('新規計測なしで確定値だけを読み、実測 0 件・未測定・個別失敗を区別する', async () => {
  const expression = '"A"[Mesh] OR "B"[Mesh] OR x[tiab] OR y[tiab]';
  const terms = extractBlockTerms(expression).freewordTerms;
  const result = await analyzeFreewordDelta(terms, async (query) => {
    if (query === 'y[tiab]') throw new Error('取得失敗');
    return 0;
  });
  const snapshots = {
    hitsSnapshot: new Map([[meshHitQuery('A'), 0]]),
    freewordDeltaSnapshot: new Map([[freewordCacheKey(terms), result]]),
  };
  expect(collectMeasuredContext(expression, snapshots)).toEqual({
    keywordHits: [
      { term: 'A', kind: 'mesh', hits: 0 },
      { term: 'x[tiab]', kind: 'freeword', hits: 0, delta: 0, status: 'normal' },
      { term: 'y[tiab]', kind: 'freeword', hits: null, delta: null, status: null },
    ],
    freewordDedupTotal: 0,
  });
  expect(collectMeasuredContext(expression, {})).toEqual({ keywordHits: [], freewordDedupTotal: null });
  expect(collectMeasuredContext('z[tiab]', snapshots)).toEqual({ keywordHits: [], freewordDedupTotal: null });
  expect(collectMeasuredContext('', snapshots)).toEqual({ keywordHits: [], freewordDedupTotal: null });
  expect(freewordCacheKey([...terms].reverse())).toBe(freewordCacheKey(terms));
});

test('祖先経路と MeSH 件数クエリを従来どおり組み立てる', () => {
  expect(spineTreeNumbers('M01.526.485')).toEqual(['M', 'M01', 'M01.526', 'M01.526.485']);
  expect(spineTreeNumbers('M01')).toEqual(['M', 'M01']);
  expect(spineTreeNumbers('')).toEqual(['']);
  expect(meshHitQuery('A')).toBe('"A"[Mesh]');
});
