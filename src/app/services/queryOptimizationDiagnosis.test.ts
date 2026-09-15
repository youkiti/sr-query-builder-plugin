import type { OptimizationTrial } from '@/features/formula/skills/optimizeQuery';
import type { BlockDiagnosis } from '@/features/validation/blockDiagnosis';
import { diagnosedHeldBlock } from './queryOptimizationDiagnosis';

const diagnosis: BlockDiagnosis = { fingerprint: 'f', overlaps: [], note: '', narrowing: [
  { blockId: '1', label: '疾患', finalHits: 90, withoutHits: 100, reduction: 0.1, ineffective: true, note: '' },
] };
function trial(id: string, held: boolean, extra: Partial<OptimizationTrial> = {}): OptimizationTrial {
  return { kind: 'proposal', candidateId: 'c', formula: { blocks: [], combinationExpression: null },
    before: null, after: null, reason: '', rationale: '', apiEvents: [], accepted: false, held,
    impact: { lostHits: 1, gainedHits: 0, inspected: [], error: null },
    formulaDiff: [{ blockId: id, added: ['追加'], removed: [] }], ...extra };
}
test('別ブロックの採用が挟まっても実式の差分を優先して保留を数える', () => {
  expect(diagnosedHeldBlock([trial('1', true), trial('2', false, { accepted: true }), trial('1', true, {
    changes: { targetBlockId: '2', addedTerms: [], removedTerms: [], replacedTerms: [] },
  })], diagnosis)).toBe('1');
});

test.each([
  { losses: [null, 5, null], expected: null },
  { losses: [5, null, 3], expected: '1' },
])('差集合の取得失敗は保留を数えず連続も途切れさせない: $losses', ({ losses, expected }) => {
  expect(diagnosedHeldBlock(losses.map((lostHits) => trial('1', true, {
    impact: { lostHits, gainedHits: 0, inspected: [], error: null },
  })), diagnosis)).toBe(expected);
});

test.each([
  undefined,
  { lostHits: 0, gainedHits: null, inspected: [], error: null },
])('実測で失う集合を確認できない保留は数えず連続も途切れさせない: %j', (impact) => {
  const failed = trial('1', true, { impact });
  expect(diagnosedHeldBlock([failed, failed], diagnosis)).toBeNull();
  expect(diagnosedHeldBlock([trial('1', true), failed, trial('1', true)], diagnosis)).toBe('1');
});
test.each([true, false])('同じブロックの採用・却下で数え直す: %s', (accepted) => {
  expect(diagnosedHeldBlock([trial('1', true), trial('1', false, { accepted }), trial('1', true)], diagnosis)).toBeNull();
});
test('測定前の同一式却下を無視し、診断外の保留を数えない', () => {
  expect(diagnosedHeldBlock([trial('1', true), trial('1', false, { duplicateOf: 'c' }), trial('1', true)], diagnosis)).toBe('1');
  expect(diagnosedHeldBlock([trial('2', true), trial('2', true)], diagnosis)).toBeNull();
});
test('複数ブロックの差分は申告した対象を使い、重なりも対象にする', () => {
  const item = trial('1', true, { formulaDiff: [{ blockId: '1', added: ['a'], removed: [] }, { blockId: '2', added: ['b'], removed: [] }],
    changes: { targetBlockId: '2', addedTerms: [], removedTerms: [], replacedTerms: [] } });
  expect(diagnosedHeldBlock([item, item], { ...diagnosis, narrowing: [], overlaps: [
    { blockIds: ['1', '2'], kind: 'same', terms: [], qualified: false, note: '' },
  ] })).toBe('2');
});
