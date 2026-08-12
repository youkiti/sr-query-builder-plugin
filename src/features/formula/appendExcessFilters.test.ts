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
    expect(() => appendExcessFilterBlocks(BASE_MD, [])).toThrow('追記するフィルタがありません');
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

  test('結合行が最終行でなくても、最後の結合行の直前へ挿入する', () => {
    const md = `## PubMed/MEDLINE

\`\`\`
#1 "asthma"[tiab]
#2 "children"[tiab]
#3 #1 AND #2
#4 english[la]
\`\`\`
`;
    const result = appendExcessFilterBlocks(md, [{ label: 'A', expression: 'a[filter]' }]);
    const formula = parsePubmedFormulaMd(result);
    // #4 は結合行ではないので後ろに残り、Filter1 は #3 の直前に入る
    expect(formula.blocks.map((b) => b.id)).toEqual(['1', '2', 'Filter1', '3', '4']);
    expect(formula.blocks[3]?.expression).toBe('#1 AND #2 AND #Filter1');
  });

  test('search_formula.md 互換の体裁（見出し + コードブロック）を保つ', () => {
    const result = appendExcessFilterBlocks(BASE_MD, [{ label: 'A', expression: 'a[filter]' }]);
    expect(result.startsWith('## PubMed/MEDLINE\n\n```\n')).toBe(true);
    expect(result.endsWith('```\n')).toBe(true);
    // 各行は `#<id> <expression>` 形式
    const body = result.split('```')[1] ?? '';
    for (const line of body.trim().split('\n')) {
      expect(line).toMatch(/^#[A-Za-z0-9]+ .+$/);
    }
  });
});
