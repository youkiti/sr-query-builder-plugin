/**
 * PubMed の検索ページ URL を検索式から組み立てる。
 * 完了画面（`#/done`）で「PubMed を開く」ボタンのリンク先に使う。
 */
export function buildPubmedSearchUrl(query: string): string {
  const base = 'https://pubmed.ncbi.nlm.nih.gov/';
  const params = new URLSearchParams({ term: query });
  return `${base}?${params.toString()}`;
}
