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
  /**
   * リトライしても解消しない恒久エラー（構文エラー・不明タグ等の in-band エラー）なら true。
   * retryWithBackoff の shouldRetry でリトライ対象外にするための判定に使う。
   */
  readonly permanent: boolean;
  constructor(message: string, status: number, permanent = false) {
    super(message);
    this.name = 'EutilsError';
    this.status = status;
    this.permanent = permanent;
  }
}

/** 恒久エラー（permanent な EutilsError）だけリトライしない共通判定。 */
function shouldRetryEutils(err: unknown): boolean {
  return !(err instanceof EutilsError && err.permanent);
}

/**
 * esearch の JSON レスポンス。HTTP 200 でもクエリの構文エラー等は
 * `ERROR` / `errorlist`（in-band エラー）として返るため、count だけでなくこれらも見る。
 */
interface EsearchResponseJson {
  esearchresult?: {
    count?: string;
    idlist?: string[];
    ERROR?: string;
    errorlist?: {
      phrasesnotfound?: string[];
      fieldsnotfound?: string[];
    };
    warninglist?: {
      phrasesignored?: string[];
      quotedphrasesnotfound?: string[];
      outputmessages?: string[];
    };
  };
  /** トップレベルの error（rate limit 超過時の "API rate limit exceeded" 等） */
  error?: string;
}

/**
 * esearch レスポンスの in-band エラーを検査し、エラーなら permanent な EutilsError を throw する。
 * 「0 件」と「構文エラー」を区別するための検出（fix-plan 1-1）。
 * warninglist（stopword 無視等）は正常系の揺らぎなのでエラーにしない。
 */
function assertNoInbandError(json: EsearchResponseJson): void {
  const result = json.esearchresult;
  const phrasesNotFound = result?.errorlist?.phrasesnotfound ?? [];
  const fieldsNotFound = result?.errorlist?.fieldsnotfound ?? [];
  if (fieldsNotFound.length > 0) {
    const fields = fieldsNotFound.map((f) => `[${f}]`).join(', ');
    throw new EutilsError(`構文エラー: 不明なフィールドタグ ${fields}`, 200, true);
  }
  if (phrasesNotFound.length > 0) {
    const phrases = phrasesNotFound.map((p) => `"${p}"`).join(', ');
    throw new EutilsError(`構文エラー: phrase not found ${phrases}`, 200, true);
  }
  if (result?.ERROR) {
    throw new EutilsError(`esearch エラー: ${result.ERROR}`, 200, true);
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
      const body = (await res.json()) as EsearchResponseJson;
      if (body.error) {
        // HTTP 200 で返る rate limit 等の一時エラー。permanent ではないのでリトライ対象
        throw new EutilsError(`esearch エラー: ${body.error}`, res.status);
      }
      assertNoInbandError(body);
      return body;
    },
    { sleep: deps.sleep, maxRetries: deps.maxRetries ?? 5, shouldRetry: shouldRetryEutils }
  );

  const result = json.esearchresult;
  const count = result?.count !== undefined ? Number.parseInt(result.count, 10) : 0;
  const pmids = result?.idlist ?? [];
  return { count: Number.isFinite(count) ? count : 0, pmids };
}

/** MeSH qualifier（subheading）。例: `/drug therapy` */
export interface MeshQualifierDetail {
  name: string;
  majorTopic: boolean;
}

/** MeSH heading の構造化表現（descriptor + MajorTopic + qualifiers）。 */
export interface MeshHeadingDetail {
  descriptor: string;
  /** DescriptorName の MajorTopicYN="Y"（論文の主題として索引されている） */
  majorTopic: boolean;
  qualifiers: MeshQualifierDetail[];
}

export interface EfetchArticle {
  pmid: string;
  title: string | null;
  year: number | null;
  /** 後方互換: descriptor 文字列のみの一覧。詳細は meshDetails を参照 */
  meshHeadings: string[];
  /** MajorTopic / qualifier を含む構造化 MeSH（meshHeadings と同順） */
  meshDetails: MeshHeadingDetail[];
  abstract: string | null;
  journal: string | null;
  authors: string[];
  volume: string | null;
  issue: string | null;
  pages: string | null;
  doi: string | null;
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
    const meshDetails: MeshHeadingDetail[] = [];
    for (const heading of Array.from(article.getElementsByTagName('MeshHeading'))) {
      const descriptorEl = heading.getElementsByTagName('DescriptorName')[0];
      const descriptor = descriptorEl?.textContent?.trim();
      if (!descriptor) {
        continue;
      }
      const qualifiers: MeshQualifierDetail[] = [];
      for (const q of Array.from(heading.getElementsByTagName('QualifierName'))) {
        const name = q.textContent?.trim();
        if (name) {
          qualifiers.push({ name, majorTopic: q.getAttribute('MajorTopicYN') === 'Y' });
        }
      }
      meshHeadings.push(descriptor);
      meshDetails.push({
        descriptor,
        majorTopic: descriptorEl?.getAttribute('MajorTopicYN') === 'Y',
        qualifiers,
      });
    }
    const abstract = collectAbstract(article);
    const journal =
      article.getElementsByTagName('Title')[0]?.textContent?.trim() ??
      article.getElementsByTagName('ISOAbbreviation')[0]?.textContent?.trim() ??
      null;
    const authors = collectAuthors(article);
    const journalIssue = article.getElementsByTagName('JournalIssue')[0];
    const volume = journalIssue?.getElementsByTagName('Volume')[0]?.textContent?.trim() ?? null;
    const issue = journalIssue?.getElementsByTagName('Issue')[0]?.textContent?.trim() ?? null;
    const pages =
      article.getElementsByTagName('MedlinePgn')[0]?.textContent?.trim() ?? null;
    const doi = collectDoi(article);
    if (pmid !== '') {
      articles.push({
        pmid,
        title,
        year,
        meshHeadings,
        meshDetails,
        abstract,
        journal,
        authors,
        volume,
        issue,
        pages,
        doi,
      });
    }
  }
  return articles;
}

function collectAbstract(article: Element): string | null {
  const parts: string[] = [];
  for (const node of Array.from(article.getElementsByTagName('AbstractText'))) {
    const text = node.textContent?.trim();
    if (!text) {
      continue;
    }
    const label = node.getAttribute('Label');
    parts.push(label ? `${label}: ${text}` : text);
  }
  if (parts.length === 0) {
    return null;
  }
  return parts.join('\n\n');
}

function collectAuthors(article: Element): string[] {
  const authors: string[] = [];
  for (const author of Array.from(article.getElementsByTagName('Author'))) {
    const collective = author.getElementsByTagName('CollectiveName')[0]?.textContent?.trim();
    if (collective) {
      authors.push(collective);
      continue;
    }
    const last = author.getElementsByTagName('LastName')[0]?.textContent?.trim();
    const initials = author.getElementsByTagName('Initials')[0]?.textContent?.trim();
    const fore = author.getElementsByTagName('ForeName')[0]?.textContent?.trim();
    if (last && initials) {
      authors.push(`${last} ${initials}`);
    } else if (last && fore) {
      authors.push(`${last} ${fore}`);
    } else if (last) {
      authors.push(last);
    }
  }
  return authors;
}

function collectDoi(article: Element): string | null {
  for (const id of Array.from(article.getElementsByTagName('ArticleId'))) {
    if (id.getAttribute('IdType') === 'doi') {
      const value = id.textContent?.trim();
      if (value) {
        return value;
      }
    }
  }
  for (const id of Array.from(article.getElementsByTagName('ELocationID'))) {
    if (id.getAttribute('EIdType') === 'doi') {
      const value = id.textContent?.trim();
      if (value) {
        return value;
      }
    }
  }
  return null;
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
