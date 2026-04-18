import type { PubmedFormula } from '@/lib/search-formula-md';
import { convertToDialog } from './toDialog';

function makeFormula(blocks: Array<{ id: string; expression: string }>): PubmedFormula {
  return {
    blocks: blocks.map((b) => ({ ...b, isCombination: false })),
    combinationExpression: null,
  };
}

describe('convertToDialog', () => {
  test('"term"[Mesh] → EMB.EXACT.EXPLODE("term") かつ SN 番号', () => {
    const result = convertToDialog(makeFormula([{ id: '1', expression: '"Diabetes"[Mesh]' }]));
    expect(result.convertedFormula).toBe('S1 EMB.EXACT.EXPLODE("Diabetes")');
    expect(result.targetDb).toBe('dialog');
  });

  test('"phrase"[tiab] → (TI("phrase") OR AB("phrase"))', () => {
    const result = convertToDialog(
      makeFormula([{ id: '1', expression: '"heart failure"[tiab]' }])
    );
    expect(result.convertedFormula).toContain('(TI("heart failure") OR AB("heart failure"))');
  });

  test('bare term[tiab] → (TI(term) OR AB(term))', () => {
    const result = convertToDialog(makeFormula([{ id: '1', expression: 'aspirin[tiab]' }]));
    expect(result.convertedFormula).toContain('(TI(aspirin) OR AB(aspirin))');
  });

  test('[Title] → TI()', () => {
    const result = convertToDialog(makeFormula([{ id: '1', expression: '"X"[Title]' }]));
    expect(result.convertedFormula).toContain('TI("X")');
  });

  test('[ad] は削除 + 警告', () => {
    const result = convertToDialog(makeFormula([{ id: '1', expression: 'stanford[ad]' }]));
    expect(result.convertedFormula).toBe('S1 stanford');
    expect(result.warnings[0]).toContain('[ad]');
  });

  test('近接演算子 [tiab:~2] は警告のみ', () => {
    const result = convertToDialog(
      makeFormula([{ id: '1', expression: '"A B"[tiab:~2]' }])
    );
    expect(result.warnings[0]).toContain('近接演算子');
  });

  test('近接演算子 [Title:~0] も検知する', () => {
    const result = convertToDialog(
      makeFormula([{ id: '1', expression: '"A B"[Title:~0]' }])
    );
    expect(result.warnings[0]).toContain('近接演算子');
  });

  test('#N 参照は SN に変換する', () => {
    const result = convertToDialog(
      makeFormula([
        { id: '1', expression: 'x' },
        { id: '2', expression: '#1 AND y' },
      ])
    );
    expect(result.convertedFormula).toContain('S2 S1 AND y');
  });
});
