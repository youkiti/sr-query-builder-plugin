import type { EutilsDeps } from '@/lib/ncbi';
import { esearch } from '@/lib/ncbi';
import type { PubmedFormula } from '@/lib/search-formula-md';
import { expandFormula } from './expandFormula';

/**
 * 各ブロック（検索式の 1 行）のヒット数を取得する。
 * requirements.md §4.6 の `line_hits` 検証に対応。
 *
 * `#N` 参照を含むブロック（combination 行）は全展開後に esearch する。
 */
export interface LineHitResult {
  blockId: string;
  expression: string;
  /** 展開後の PubMed クエリ（そのまま esearch に投げた文字列） */
  expandedQuery: string;
  hitCount: number;
  error: string | null;
}

export async function checkSearchLines(
  formula: PubmedFormula,
  deps: EutilsDeps
): Promise<LineHitResult[]> {
  const results: LineHitResult[] = [];
  for (const block of formula.blocks) {
    try {
      const expandedQuery = expandFormula(formula, block.id);
      const { count } = await esearch(expandedQuery, deps, { retmax: 0 });
      results.push({
        blockId: block.id,
        expression: block.expression,
        expandedQuery,
        hitCount: count,
        error: null,
      });
    } catch (err) {
      results.push({
        blockId: block.id,
        expression: block.expression,
        expandedQuery: '',
        hitCount: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}
