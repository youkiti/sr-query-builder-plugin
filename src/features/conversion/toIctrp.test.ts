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

  test('未知のブラケット表記は既知タグではないため削除しないが、警告は出す（黙って残さない）', () => {
    const result = convertToIctrp(
      makeFormula([{ id: '1', expression: 'foo[Not-A-Tag] OR bar[tiab]' }])
    );
    expect(result.convertedFormula).toContain('foo[Not-A-Tag]');
    expect(result.convertedFormula).toContain('bar');
    expect(result.convertedFormula).not.toContain('[tiab]');
    const residualWarning = result.warnings.find((w) => w.includes('変換できなかったフィールドタグ'));
    expect(residualWarning).toBeDefined();
    expect(residualWarning).toContain('[Not-A-Tag]');
  });

  test('[Mesh:NoExp] のような修飾つきタグも既知タグとして削除する（警告なし）', () => {
    const result = convertToIctrp(makeFormula([{ id: '1', expression: '"Aspirin"[Mesh:NoExp]' }]));
    expect(result.convertedFormula).toBe('#1 "Aspirin"');
    expect(result.warnings.some((w) => w.includes('変換できなかったフィールドタグ'))).toBe(false);
  });

  describe('実在する PubMed タグの網羅（issue #60 レビュー指摘）', () => {
    test.each([
      ['medline[sb]', 'medline', 'sb'],
      ['aspirin[nm]', 'aspirin', 'nm'],
      ['smith j[au]', 'smith j', 'au'],
      ['lancet[ta]', 'lancet', 'ta'],
      ['cancer[All Fields]', 'cancer', 'All Fields'],
      ['2020[pdat]', '2020', 'pdat'],
      ['therapy[Text Word]', 'therapy', 'Text Word'],
      ['x[Supplementary Concept]', 'x', 'Supplementary Concept'],
    ])('%s は既知タグとして削除され、警告も出ない', (expression, expectedTerm, tag) => {
      const result = convertToIctrp(makeFormula([{ id: '1', expression }]));
      expect(result.convertedFormula).toBe(`#1 ${expectedTerm}`);
      expect(result.convertedFormula).not.toContain(`[${tag}]`);
      expect(result.warnings.some((w) => w.includes('変換できなかったフィールドタグ'))).toBe(false);
    });
  });
});
