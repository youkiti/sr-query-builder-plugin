import type { EutilsDeps } from '@/lib/ncbi';
import { esearch } from '@/lib/ncbi';
import type { PubmedFormula } from '@/lib/search-formula-md';
import { expandFormula } from './expandFormula';

/**
 * 最終検索式でシード論文がどれだけ捕捉できているかを検証する。
 * requirements.md §4.6 の `final_query` 検証に対応。
 *
 * アルゴリズム:
 * 1. combination ブロックを展開して最終クエリ文字列を得る
 * 2. 最終クエリ単体で esearch → `totalHits`
 * 3. `(最終クエリ) AND (pmid1[uid] OR pmid2[uid] OR ...)` で esearch
 *    → 捕捉された PMID 集合を得る（seed の件数 = retmax）
 * 4. seed の差集合で未捕捉 PMID を確定
 */
export interface FinalQueryResult {
  finalQuery: string;
  totalHits: number;
  captureRate: number;
  capturedPmids: string[];
  missedPmids: string[];
}

export async function checkFinalQuery(
  formula: PubmedFormula,
  seedPmids: readonly string[],
  deps: EutilsDeps
): Promise<FinalQueryResult> {
  const finalQuery = expandFormula(formula);
  const { count: totalHits } = await esearch(finalQuery, deps, { retmax: 0 });

  if (seedPmids.length === 0) {
    return {
      finalQuery,
      totalHits,
      captureRate: 0,
      capturedPmids: [],
      missedPmids: [],
    };
  }

  const uidClause = seedPmids.map((p) => `${p}[uid]`).join(' OR ');
  const capturedQuery = `(${finalQuery}) AND (${uidClause})`;
  const { pmids: esearchPmids } = await esearch(capturedQuery, deps, {
    retmax: seedPmids.length,
  });
  // esearch は理論上 seed 以外の PMID を返さないはずだが、クエリ展開や API の
  // 揺らぎで seed 外 PMID が混ざると capture_rate と missed_pmids が矛盾する。
  // capturedPmids を必ず seed 集合との積集合に限定し、捕捉率・未捕捉を一貫して計算する。
  const esearchSet = new Set(esearchPmids);
  const capturedPmids = seedPmids.filter((p) => esearchSet.has(p));
  const capturedSet = new Set(capturedPmids);
  const missedPmids = seedPmids.filter((p) => !capturedSet.has(p));

  return {
    finalQuery,
    totalHits,
    captureRate: capturedSet.size / seedPmids.length,
    capturedPmids,
    missedPmids,
  };
}
