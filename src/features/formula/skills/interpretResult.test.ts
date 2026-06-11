import type { ChatMessage, LLMProvider } from '@/lib/llm';
import {
  interpretResult,
  type FormulaLineInput,
  type MissedArticleInput,
} from './interpretResult';

function provider(text: string): { provider: LLMProvider; calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  return {
    calls,
    provider: {
      providerId: 'gemini',
      model: 'test',
      chat: async (messages) => {
        calls.push([...messages]);
        return { text, tokensIn: null, tokensOut: null, raw: {} };
      },
    },
  };
}

const lines: FormulaLineInput[] = [
  { blockId: '1', expression: '"ARDS"[tiab]' },
  { blockId: '2', expression: '"ECMO"[tiab]' },
];

const articles: MissedArticleInput[] = [
  {
    pmid: '444',
    title: 'Extracorporeal support in acute lung injury',
    abstract: 'A trial of ECMO in acute lung injury patients.',
    meshHeadings: ['Acute Lung Injury', 'Extracorporeal Membrane Oxygenation'],
  },
  {
    pmid: '555',
    title: null,
    abstract: null,
    meshHeadings: [],
  },
];

describe('interpretResult', () => {
  test('漏れ論文が 0 件なら LLM を呼ばず空配列を返す', async () => {
    const { provider: p, calls } = provider('{}');
    const result = await interpretResult(
      { finalQuery: 'q', lines, missedArticles: [] },
      p
    );
    expect(result).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test('PMID ごとの原因・候補語・関連ブロックを返す', async () => {
    const json = JSON.stringify({
      analyses: [
        {
          pmid: '444',
          cause: 'acute lung injury という表現が #1 に無いため捕捉できていません。',
          suggested_terms: ['"acute lung injury"[tiab]', '"Acute Lung Injury"[MeSH Terms]'],
          related_block: '1',
        },
        {
          pmid: '555',
          cause: '抄録が無く判断材料が乏しいです。',
          suggested_terms: [],
          related_block: null,
        },
      ],
    });
    const { provider: p } = provider(json);
    const result = await interpretResult(
      { finalQuery: 'q', lines, missedArticles: articles },
      p
    );
    expect(result).toEqual([
      {
        pmid: '444',
        cause: 'acute lung injury という表現が #1 に無いため捕捉できていません。',
        suggestedTerms: ['"acute lung injury"[tiab]', '"Acute Lung Injury"[MeSH Terms]'],
        relatedBlock: '1',
      },
      {
        pmid: '555',
        cause: '抄録が無く判断材料が乏しいです。',
        suggestedTerms: [],
        relatedBlock: null,
      },
    ]);
  });

  test('想定 PMID 以外は除外する', async () => {
    const json = JSON.stringify({
      analyses: [
        { pmid: '999', cause: 'not in list', suggested_terms: ['x'], related_block: '1' },
        { pmid: '444', cause: 'ok', suggested_terms: [], related_block: null },
      ],
    });
    const { provider: p } = provider(json);
    const result = await interpretResult(
      { finalQuery: 'q', lines, missedArticles: articles },
      p
    );
    expect(result.map((a) => a.pmid)).toEqual(['444']);
  });

  test('重複 PMID は先勝ちで 1 件だけ残す', async () => {
    const json = JSON.stringify({
      analyses: [
        { pmid: '444', cause: 'first', suggested_terms: [], related_block: '1' },
        { pmid: '444', cause: 'second', suggested_terms: [], related_block: '2' },
      ],
    });
    const { provider: p } = provider(json);
    const result = await interpretResult(
      { finalQuery: 'q', lines, missedArticles: articles },
      p
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.cause).toBe('first');
  });

  test('related_block の文字列 "null" は null に正規化する', async () => {
    const json = JSON.stringify({
      analyses: [{ pmid: '444', cause: 'c', suggested_terms: [], related_block: 'null' }],
    });
    const { provider: p } = provider(json);
    const result = await interpretResult(
      { finalQuery: 'q', lines, missedArticles: articles },
      p
    );
    expect(result[0]!.relatedBlock).toBeNull();
  });

  test('suggested_terms が配列でない / 非文字列を含む場合も落ちない', async () => {
    const json = JSON.stringify({
      analyses: [
        { pmid: '444', cause: 'c', suggested_terms: 'not-array', related_block: '1' },
        { pmid: '555', cause: 'c2', suggested_terms: ['ok', 3, '', '  '], related_block: '2' },
      ],
    });
    const { provider: p } = provider(json);
    const result = await interpretResult(
      { finalQuery: 'q', lines, missedArticles: articles },
      p
    );
    expect(result[0]!.suggestedTerms).toEqual([]);
    expect(result[1]!.suggestedTerms).toEqual(['ok']);
  });

  test('analyses 欠落や各フィールド欠落でも落ちない', async () => {
    const { provider: empty } = provider('{}');
    expect(
      await interpretResult({ finalQuery: 'q', lines, missedArticles: articles }, empty)
    ).toEqual([]);

    const { provider: partial } = provider(JSON.stringify({ analyses: [{ pmid: '444' }] }));
    const r = await interpretResult(
      { finalQuery: 'q', lines, missedArticles: articles },
      partial
    );
    expect(r).toEqual([
      { pmid: '444', cause: '', suggestedTerms: [], relatedBlock: null },
    ]);
  });

  test('プロンプトに書誌情報と検索式の行が埋め込まれる', async () => {
    const { provider: p, calls } = provider(JSON.stringify({ analyses: [] }));
    await interpretResult(
      { finalQuery: '(#1) AND (#2)', lines, missedArticles: articles },
      p
    );
    const userMsg = calls[0]!.find((m) => m.role === 'user')?.content ?? '';
    // 検索式と行
    expect(userMsg).toContain('(#1) AND (#2)');
    expect(userMsg).toContain('#1: "ARDS"[tiab]');
    expect(userMsg).toContain('#2: "ECMO"[tiab]');
    // 書誌（title / abstract / MeSH）
    expect(userMsg).toContain('PMID 444');
    expect(userMsg).toContain('Extracorporeal support in acute lung injury');
    expect(userMsg).toContain('A trial of ECMO in acute lung injury patients.');
    expect(userMsg).toContain('Acute Lung Injury, Extracorporeal Membrane Oxygenation');
    // null フィールドはプレースホルダ
    expect(userMsg).toContain('(no title)');
    expect(userMsg).toContain('(no abstract)');
    // 件数
    expect(userMsg).toContain('漏れ PMID（2 件）');
    // テンプレート変数が残らない
    expect(userMsg).not.toContain('{{FINAL_QUERY}}');
    expect(userMsg).not.toContain('{{ARTICLES}}');
  });

  test('finalQuery が空なら (未提供) プレースホルダ', async () => {
    const { provider: p, calls } = provider(JSON.stringify({ analyses: [] }));
    await interpretResult({ finalQuery: '   ', lines, missedArticles: articles }, p);
    const userMsg = calls[0]!.find((m) => m.role === 'user')?.content ?? '';
    expect(userMsg).toContain('(未提供)');
  });
});
