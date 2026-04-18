import type { PubmedFormula } from '@/lib/search-formula-md';
import { convertToIctrp } from './toIctrp';

function makeFormula(blocks: Array<{ id: string; expression: string }>): PubmedFormula {
  return {
    blocks: blocks.map((b) => ({ ...b, isCombination: false })),
    combinationExpression: null,
  };
}

describe('convertToIctrp', () => {
  test('フィールドタグ + ワイルドカードを削除', () => {
    const result = convertToIctrp(
      makeFormula([{ id: '1', expression: '"Metformin"[Mesh] OR metformin*[tiab]' }])
    );
    expect(result.convertedFormula).toBe('#1 "Metformin" OR metformin');
    expect(result.warnings.some((w) => w.includes('ワイルドカード'))).toBe(true);
  });

  test('近接演算子は AND に退化 + 警告', () => {
    const result = convertToIctrp(
      makeFormula([{ id: '1', expression: '"heart failure"[tiab:~2]' }])
    );
    expect(result.convertedFormula).toContain('(heart AND failure)');
    expect(result.warnings.some((w) => w.includes('近接'))).toBe(true);
  });

  test('[Title:~0] も AND に退化', () => {
    const result = convertToIctrp(
      makeFormula([{ id: '1', expression: '"foo bar"[Title:~0]' }])
    );
    expect(result.convertedFormula).toContain('(foo AND bar)');
  });

  test('#N 参照は警告として残す', () => {
    const result = convertToIctrp(makeFormula([{ id: '2', expression: '#1 AND more' }]));
    expect(result.warnings.some((w) => w.includes('#N 行参照'))).toBe(true);
  });

  test('ワイルドカードが無ければ警告は出ない', () => {
    const result = convertToIctrp(makeFormula([{ id: '1', expression: 'aspirin[tiab]' }]));
    expect(result.warnings.every((w) => !w.includes('ワイルドカード'))).toBe(true);
  });
});
