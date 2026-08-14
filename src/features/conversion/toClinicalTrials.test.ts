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

  test('未知のブラケット表記は既知タグではないため削除しないが、警告は出す（黙って残さない）', () => {
    const result = convertToClinicalTrials(
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
    const result = convertToClinicalTrials(
      makeFormula([{ id: '1', expression: '"Aspirin"[Mesh:NoExp]' }])
    );
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
      const result = convertToClinicalTrials(makeFormula([{ id: '1', expression }]));
      expect(result.convertedFormula).toBe(`#1 ${expectedTerm}`);
      expect(result.convertedFormula).not.toContain(`[${tag}]`);
      expect(result.warnings.some((w) => w.includes('変換できなかったフィールドタグ'))).toBe(false);
    });
  });
});
