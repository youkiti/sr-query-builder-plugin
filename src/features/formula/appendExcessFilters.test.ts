import { appendExcessFilterBlocks, AppendExcessFiltersError } from './appendExcessFilters';
import { parsePubmedFormulaMd } from '@/lib/search-formula-md';

const BASE_MD = `## PubMed/MEDLINE

\`\`\`
#1 "asthma"[tiab]
#2 "children"[tiab]
#3 #1 AND #2
\`\`\`
`;

describe('appendExcessFilterBlocks', () => {
  test('承認フィルタを結合行の直前に挿入し、結合式へ AND 参照を追記する', () => {
    const result = appendExcessFilterBlocks(BASE_MD, [
      { label: '英語論文に限定', expression: 'english[la]' },
    ]);
    const formula = parsePubmedFormulaMd(result);
    expect(formula.blocks.map((b) => b.id)).toEqual(['1', '2', 'Filter1', '3']);
    expect(formula.blocks[2]?.expression).toBe('english[la]');
    expect(formula.combinationExpression).toBe('#1 AND #2 AND #Filter1');
  });

  test('複数フィルタは Filter1, Filter2 と連番で追記される', () => {
    const result = appendExcessFilterBlocks(BASE_MD, [
      { label: 'A', expression: 'a[filter]' },
      { label: 'B', expression: 'b[filter]' },
    ]);
    const formula = parsePubmedFormulaMd(result);
    expect(formula.blocks.map((b) => b.id)).toEqual(['1', '2', 'Filter1', 'Filter2', '3']);
    expect(formula.combinationExpression).toBe('#1 AND #2 AND #Filter1 AND #Filter2');
  });

  test('既存の Filter1 と衝突しない ID を採番する（大文字小文字を区別しない）', () => {
    const md = `## PubMed/MEDLINE

\`\`\`
#1 "asthma"[tiab]
#filter1 english[la]
#3 #1 AND #filter1
\`\`\`
`;
    const result = appendExcessFilterBlocks(md, [{ label: 'A', expression: 'a[filter]' }]);
    const formula = parsePubmedFormulaMd(result);
    expect(formula.blocks.map((b) => b.id)).toEqual(['1', 'filter1', 'Filter2', '3']);
    expect(formula.combinationExpression).toBe('#1 AND #filter1 AND #Filter2');
  });

  test('式の前後空白は取り除いて追記する', () => {
    const result = appendExcessFilterBlocks(BASE_MD, [
      { label: 'A', expression: '  english[la]  ' },
    ]);
    expect(result).toContain('#Filter1 english[la]');
  });

  test('結合行が無い式は AppendExcessFiltersError', () => {
    const md = `## PubMed/MEDLINE

\`\`\`
#1 "asthma"[tiab]
\`\`\`
`;
    expect(() => appendExcessFilterBlocks(md, [{ label: 'A', expression: 'a' }])).toThrow(
      AppendExcessFiltersError
    );
    expect(() => appendExcessFilterBlocks(md, [{ label: 'A', expression: 'a' }])).toThrow(
      '結合行が見つかりません'
    );
  });

  test('空のフィルタ配列は AppendExcessFiltersError', () => {
    expect(() => appendExcessFilterBlocks(BASE_MD, [])).toThrow(AppendExcessFiltersError);
  });

  test('式が空の候補は AppendExcessFiltersError', () => {
    expect(() =>
      appendExcessFilterBlocks(BASE_MD, [{ label: '空の候補', expression: '   ' }])
    ).toThrow('空の候補');
  });

  test('元の md は変更されず、返り値は再パース可能', () => {
    const result = appendExcessFilterBlocks(BASE_MD, [{ label: 'A', expression: 'a[filter]' }]);
    expect(BASE_MD).not.toContain('Filter1');
    expect(() => parsePubmedFormulaMd(result)).not.toThrow();
  });
});
