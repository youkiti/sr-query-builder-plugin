import { FormulaSerializeError, serializePubmedFormulaMd } from './serialize';
import { parsePubmedFormulaMd } from './parse';
import type { PubmedFormula } from './types';

function makeFormula(): PubmedFormula {
  return {
    blocks: [
      { id: '1', expression: 'diabetes[tiab]', isCombination: false },
      { id: '2', expression: 'metformin[tiab]', isCombination: false },
      { id: '3', expression: '#1 AND #2', isCombination: true },
    ],
    combinationExpression: '#1 AND #2',
  };
}

describe('serializePubmedFormulaMd', () => {
  test('既定で `## PubMed/MEDLINE` 見出し + コードブロック形式に出力する', () => {
    const out = serializePubmedFormulaMd(makeFormula());
    expect(out).toBe(
      ['## PubMed/MEDLINE', '', '```', '#1 diabetes[tiab]', '#2 metformin[tiab]', '#3 #1 AND #2', '```', ''].join('\n')
    );
  });

  test('heading オプションで見出しを差し替えられる', () => {
    const out = serializePubmedFormulaMd(makeFormula(), { heading: '## PubMed' });
    expect(out.startsWith('## PubMed\n')).toBe(true);
  });

  test('空ブロック配列でも見出し + 空コードブロックを出力する', () => {
    const out = serializePubmedFormulaMd({ blocks: [], combinationExpression: null });
    expect(out).toBe('## PubMed/MEDLINE\n\n```\n\n```\n');
  });

  test('ID が空だと FormulaSerializeError', () => {
    expect(() =>
      serializePubmedFormulaMd({
        blocks: [{ id: '', expression: 'x', isCombination: false }],
        combinationExpression: null,
      })
    ).toThrow(FormulaSerializeError);
  });

  test('ID に英数字以外が含まれると FormulaSerializeError', () => {
    expect(() =>
      serializePubmedFormulaMd({
        blocks: [{ id: 'A-1', expression: 'x', isCombination: false }],
        combinationExpression: null,
      })
    ).toThrow(/規約外/);
  });

  test('式が空白だけだと FormulaSerializeError', () => {
    expect(() =>
      serializePubmedFormulaMd({
        blocks: [{ id: '1', expression: '   ', isCombination: false }],
        combinationExpression: null,
      })
    ).toThrow(/式が空/);
  });

  test('FormulaSerializeError は name=FormulaSerializeError', () => {
    try {
      serializePubmedFormulaMd({
        blocks: [{ id: '', expression: 'x', isCombination: false }],
        combinationExpression: null,
      });
    } catch (e) {
      expect((e as Error).name).toBe('FormulaSerializeError');
      return;
    }
    throw new Error('should have thrown');
  });

  test('parse → serialize → parse でラウンドトリップ整合', () => {
    const md = serializePubmedFormulaMd(makeFormula());
    const reparsed = parsePubmedFormulaMd(md);
    expect(reparsed.blocks.map((b) => ({ id: b.id, expression: b.expression }))).toEqual(
      makeFormula().blocks.map((b) => ({ id: b.id, expression: b.expression }))
    );
    expect(reparsed.combinationExpression).toBe('#1 AND #2');
  });
});
