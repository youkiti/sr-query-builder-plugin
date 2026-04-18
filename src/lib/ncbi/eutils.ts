import { retryWithBackoff } from './rateLimit';

/**
 * NCBI E-utilities の薄いラッパ。
 *
 * - `fetch` は必ず注入（ブラウザの `fetch` / `jsdom` のモックどちらでも使える）
 * - `apiKey` があれば NCBI の 10 req/s 枠、無ければ 3 req/s 枠になる
 * - ネットワーク障害は指数バックオフで最大 5 回リトライ
 */
export interface EutilsDeps {
  fetch: typeof fetch;
  /** NCBI API key（BYOK、未設定でも可） */
  apiKey?: string;
  /** NCBI が推奨する識別子。既定 `sr-query-builder-plugin` */
  tool?: string;
  /** 任意の連絡先メール */
  email?: string;
  /** リトライ間の sleep 関数（テスト用に差し替え可） */
  sleep?: (ms: number) => Promise<void>;
  /** 最大リトライ回数。既定 5 */
  maxRetries?: number;
}

const BASE_URL = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const DEFAULT_TOOL = 'sr-query-builder-plugin';

function appendCommonParams(params: URLSearchParams, deps: EutilsDeps): void {
  params.set('tool', deps.tool ?? DEFAULT_TOOL);
  if (deps.apiKey) {
    params.set('api_key', deps.apiKey);
  }
  if (deps.email) {
    params.set('email', deps.email);
  }
}

export class EutilsError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'EutilsError';
    this.status = status;
  }
}

export interface EsearchResult {
  /** 総ヒット数 */
  count: number;
  /** 取得できた PMID の一覧 */
  pmids: string[];
}

export interface EsearchOptions {
  /** 取得件数。既定 20、最大 10000（NCBI の仕様） */
  retmax?: number;
  /** 検索開始位置（オフセット）。既定 0 */
  retstart?: number;
}

/**
 * PubMed の esearch を呼び、ヒット数と PMID リストを取得する。
 */
export async function esearch(
  query: string,
  deps: EutilsDeps,
  options: EsearchOptions = {}
): Promise<EsearchResult> {
  const params = new URLSearchParams({
    db: 'pubmed',
    term: query,
    retmode: 'json',
    retmax: String(options.retmax ?? 20),
    retstart: String(options.retstart ?? 0),
  });
  appendCommonParams(params, deps);
  const url = `${BASE_URL}/esearch.fcgi?${params.toString()}`;

  const json = await retryWithBackoff(
    async () => {
      const res = await deps.fetch(url);
      if (!res.ok) {
        throw new EutilsError(`esearch failed: HTTP ${res.status}`, res.status);
      }
      return (await res.json()) as { esearchresult?: { count?: string; idlist?: string[] } };
    },
    { sleep: deps.sleep, maxRetries: deps.maxRetries ?? 5 }
  );

  const result = json.esearchresult;
  const count = result?.count !== undefined ? Number.parseInt(result.count, 10) : 0;
  const pmids = result?.idlist ?? [];
  return { count: Number.isFinite(count) ? count : 0, pmids };
}

export interface EfetchArticle {
  pmid: string;
  title: string | null;
  year: number | null;
  meshHeadings: string[];
}

/**
 * efetch で PubMed 記事の title / year / MeSH を取得する。
 * XML レスポンスを DOMParser でパースするため、実行環境には DOMParser が必要。
 */
export async function efetchArticles(
  pmids: string[],
  deps: EutilsDeps
): Promise<EfetchArticle[]> {
  if (pmids.length === 0) {
    return [];
  }
  const params = new URLSearchParams({
    db: 'pubmed',
    id: pmids.join(','),
    retmode: 'xml',
  });
  appendCommonParams(params, deps);
  const url = `${BASE_URL}/efetch.fcgi?${params.toString()}`;

  const xml = await retryWithBackoff(
    async () => {
      const res = await deps.fetch(url);
      if (!res.ok) {
        throw new EutilsError(`efetch failed: HTTP ${res.status}`, res.status);
      }
      return await res.text();
    },
    { sleep: deps.sleep, maxRetries: deps.maxRetries ?? 5 }
  );

  return parsePubmedXml(xml);
}

export function parsePubmedXml(xml: string): EfetchArticle[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, 'text/xml');
  const articles: EfetchArticle[] = [];
  for (const article of Array.from(doc.getElementsByTagName('PubmedArticle'))) {
    const pmid = article.getElementsByTagName('PMID')[0]?.textContent?.trim() ?? '';
    const title =
      article.getElementsByTagName('ArticleTitle')[0]?.textContent?.trim() ?? null;
    const yearText =
      article.getElementsByTagName('Year')[0]?.textContent?.trim() ??
      article.getElementsByTagName('MedlineDate')[0]?.textContent?.trim() ??
      null;
    const year = yearText ? parseYear(yearText) : null;
    const meshHeadings: string[] = [];
    for (const heading of Array.from(article.getElementsByTagName('MeshHeading'))) {
      const descriptor = heading.getElementsByTagName('DescriptorName')[0]?.textContent?.trim();
      if (descriptor) {
        meshHeadings.push(descriptor);
      }
    }
    if (pmid !== '') {
      articles.push({ pmid, title, year, meshHeadings });
    }
  }
  return articles;
}

function parseYear(text: string): number | null {
  const match = text.match(/\d{4}/);
  if (!match) {
    return null;
  }
  return Number.parseInt(match[0], 10);
}

/**
 * DOI から PMID を逆引きする（esearch で `doi[aid]` 検索）。
 * ヒットが 1 件のときのみ PMID を返し、0 件 / 2 件以上なら null。
 */
export async function resolvePmidByDoi(doi: string, deps: EutilsDeps): Promise<string | null> {
  const term = `${doi}[aid]`;
  const result = await esearch(term, deps, { retmax: 2 });
  const [first] = result.pmids;
  return result.pmids.length === 1 && first !== undefined ? first : null;
}
