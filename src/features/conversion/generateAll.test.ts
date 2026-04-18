import type { PubmedFormula } from '@/lib/search-formula-md';
import { convertToAllDatabases } from './generateAll';

describe('convertToAllDatabases', () => {
  const formula: PubmedFormula = {
    blocks: [
      { id: '1', expression: '"Diabetes"[Mesh]', isCombination: false },
      { id: '2', expression: 'metformin[tiab]', isCombination: false },
      { id: '3', expression: '#1 AND #2', isCombination: true },
    ],
    combinationExpression: '#1 AND #2',
  };

  test('4 DB 分の変換結果を順番（central/dialog/clinicaltrials/ictrp）で返す', () => {
    const results = convertToAllDatabases(formula);
    expect(results.map((r) => r.targetDb)).toEqual([
      'central',
      'dialog',
      'clinicaltrials',
      'ictrp',
    ]);
  });

  test('各結果に convertedFormula が入っている', () => {
    for (const r of convertToAllDatabases(formula)) {
      expect(r.convertedFormula.length).toBeGreaterThan(0);
    }
  });
});
