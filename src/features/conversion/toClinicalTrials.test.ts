import type { PubmedFormula } from '@/lib/search-formula-md';
import { convertToClinicalTrials } from './toClinicalTrials';

function makeFormula(blocks: Array<{ id: string; expression: string }>): PubmedFormula {
  return {
    blocks: blocks.map((b) => ({ ...b, isCombination: false })),
    combinationExpression: null,
  };
}

describe('convertToClinicalTrials', () => {
  test('全フィールドタグを削除する', () => {
    const result = convertToClinicalTrials(
      makeFormula([{ id: '1', expression: '"Diabetes"[Mesh] OR diabetes[tiab]' }])
    );
    expect(result.convertedFormula).toBe('#1 "Diabetes" OR diabetes');
    expect(result.targetDb).toBe('clinicaltrials');
  });

  test('近接演算子は AND に退化', () => {
    const result = convertToClinicalTrials(
      makeFormula([{ id: '1', expression: '"heart failure"[tiab:~2]' }])
    );
    expect(result.convertedFormula).toContain('(heart AND failure)');
    expect(result.warnings.some((w) => w.includes('近接'))).toBe(true);
  });

  test('[Title:~0] も AND に退化', () => {
    const result = convertToClinicalTrials(
      makeFormula([{ id: '1', expression: '"foo bar"[Title:~0]' }])
    );
    expect(result.convertedFormula).toContain('(foo AND bar)');
  });

  test('#N 参照は警告として残すが文字列は保持', () => {
    const result = convertToClinicalTrials(
      makeFormula([{ id: '2', expression: '#1 AND more' }])
    );
    expect(result.convertedFormula).toBe('#2 #1 AND more');
    expect(result.warnings.some((w) => w.includes('#N 行参照'))).toBe(true);
  });

  test('フィールド振り分け未対応の警告が必ず先頭に入る', () => {
    const result = convertToClinicalTrials(makeFormula([{ id: '1', expression: 'plain' }]));
    expect(result.warnings[0]).toContain('Condition');
  });
});
