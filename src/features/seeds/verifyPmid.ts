import type { EfetchArticle, EutilsDeps } from '@/lib/ncbi';
import { efetchArticles, esearch } from '@/lib/ncbi';

/**
 * requirements.md §4.3 で必須の「PMID 存在確認」と title / year 補完を
 * まとめて行うヘルパ。
 *
 * - 各 PMID を `esearch('<pmid>[uid]')` で実在確認
 * - 実在しているものをまとめて efetch してメタ情報取得
 * - 返り値は入力順に対応した `VerifyResult[]`
 */
export interface VerifyResult {
  pmid: string;
  isValid: boolean;
  article: EfetchArticle | null;
}

export async function verifyPmids(
  pmids: readonly string[],
  deps: EutilsDeps
): Promise<VerifyResult[]> {
  const validity = new Map<string, boolean>();
  for (const pmid of pmids) {
    const result = await esearch(`${pmid}[uid]`, deps, { retmax: 1 });
    validity.set(pmid, result.count === 1);
  }
  const validPmids = Array.from(validity.entries())
    .filter(([, v]) => v)
    .map(([pmid]) => pmid);
  const articles = await efetchArticles(validPmids, deps);
  const articleByPmid = new Map(articles.map((a) => [a.pmid, a]));

  return pmids.map((pmid) => ({
    pmid,
    isValid: validity.get(pmid) === true,
    article: articleByPmid.get(pmid) ?? null,
  }));
}

export async function verifySinglePmid(pmid: string, deps: EutilsDeps): Promise<VerifyResult> {
  const [result] = await verifyPmids([pmid], deps);
  /* istanbul ignore next -- verifyPmids は入力と同数を返すので常に defined */
  return result ?? { pmid, isValid: false, article: null };
}
