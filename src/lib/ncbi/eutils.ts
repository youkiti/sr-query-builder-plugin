import { retryWithBackoff, TokenBucket, type RateLimiter } from './rateLimit';

/**
 * NCBI E-utilities の薄いラッパ。
 *
 * - `fetch` は必ず注入（ブラウザの `fetch` / `jsdom` のモックどちらでも使える）
 * - `apiKey` があれば NCBI の 10 req/s 枠、無ければ 3 req/s 枠になる
 * - 発行前にトークンバケットで枠を守り（issue #59）、ネットワーク障害は指数バックオフで
 *   最大 5 回リトライする
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
  /**
   * 発行前トークンバケット（issue #59）。省略時はプロセス共有の既定インスタンス
   * （`sharedEutilsRateLimiters`。`apiKey` の有無で 3 req/s ／ 10 req/s を切り替える）を使う。
   * `EutilsDeps` は呼び出し側（サービス）ごとに組み立てられるため、バケットを deps 側の
   * 既定値として持たせると枠が分裂してしまう。ここへ独自実装を渡せばテストや将来の用途で
   * 丸ごと差し替えられる。
   */
  rateLimiter?: RateLimiter;
}

const BASE_URL = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const DEFAULT_TOOL = 'sr-query-builder-plugin';

/** NCBI E-utilities のレート上限（req/s）。API キー無しは 3、あり は 10。
 * https://www.ncbi.nlm.nih.gov/books/NBK25497/#chapter2.Usage_Guidelines_and_Requiremen */
export const NCBI_RATE_LIMIT_WITHOUT_API_KEY = 3;
export const NCBI_RATE_LIMIT_WITH_API_KEY = 10;

/**
 * プロセス内で共有する既定のレートリミッタ（issue #59）。
 * モジュールスコープの単一インスタンスなので、`EutilsDeps` を複数箇所（サービスごと）で
 * 組み立てても枠は分裂せず 1 プロセス全体で共有される。API キーの有無で 2 段のバケットを
 * 使い分ける（同じプロセス内でキー有り／無しの呼び出しが混在しても、それぞれの枠を守る）。
 *
 * `capacity: 1` を明示する。`TokenBucket` は `tokens = capacity` の満タン状態で始まるため、
 * `capacity` を省略する（＝既定で `ratePerSecond` と同値になる）と、その分だけ待ち時間ゼロで
 * 即時発火できてしまい「無バースト」にならない（例: capacity=3 なら、満タンの 3 個を瞬時に
 * 消費したうえで補充ぶんも同じ秒内に使えるため、最初の 1 秒間に最大 6 リクエストが飛び得る）。
 * 受け入れ条件は「任意の 1 秒窓で 3 req/s ／ 10 req/s を超えないこと」であり、これを満たすには
 * `capacity: 1`（トークンは常に高々 1 個だけ持ち、消費のたびに最小間隔ぶん待つ純粋なペーシング）
 * にする必要がある。
 * Python 版 `check_block_overlap.py` の `_respect_rate_limit` も同様に無バースト（直前
 * リクエストからの最小間隔のみを守るペーシング）であり、`capacity: 1` はそれと揃えた形。
 *
 * この無バースト設定は、状態を持ち越すモジュールスコープの共有バケットを実時間を進めない
 * テスト（`flush()` が微小な macrotask を数回回すだけで `setTimeout` の完了を待たない等）で
 * 使うと、待機が解決せず「呼び出しが起きていない」ように見える。プロダクションでは実時間が
 * 経過するため問題にならない。テスト側の対処は、そのテストが何を検証しているかで使い分ける。
 *
 * - レート制御そのものを検証するテスト（`eutils.test.ts`）: `beforeEach` で
 *   `sharedEutilsRateLimiters.*.reset()` を呼び、テスト間の累積消費を持ち越さない。
 * - 配線を検証する統合テスト（`src/app/bootstrap.test.ts`）: `reset()` では足りない。
 *   1 回の操作が capacity を超える複数リクエストを瞬時に必要とするため、満タンに戻しても
 *   そのテスト内で枯渇する。`acquire()` 自体を `jest.spyOn` でスタブして待機を無効化する
 *   （検証対象は配線であってレート制御ではなく、そちらは本ファイルと `rateLimit.test.ts`
 *   が担当するため、二重に検証する必要がない）。
 */
export const sharedEutilsRateLimiters = {
  withoutApiKey: new TokenBucket({ ratePerSecond: NCBI_RATE_LIMIT_WITHOUT_API_KEY, capacity: 1 }),
  withApiKey: new TokenBucket({ ratePerSecond: NCBI_RATE_LIMIT_WITH_API_KEY, capacity: 1 }),
};

/**
 * `deps.rateLimiter` があればそれを、無ければ `apiKey` の有無で `sharedEutilsRateLimiters` の
 * 該当バケットを返す。`mesh.ts` も `eutils.ncbi.nlm.nih.gov` を叩く（同じ 3/10 req/s の枠を
 * 共有する）ため export し、キー有無→バケットのマッピングの出所をここ 1 箇所に保つ
 * （issue #58 chunk 3a フォローアップ。バケット自体は新規に作らず、ここの単一インスタンスを
 * 再利用することで `esearch`/`efetchArticles` と枠を分裂させない）。
 */
export function resolveRateLimiter(deps: EutilsDeps): RateLimiter {
  if (deps.rateLimiter) {
    return deps.rateLimiter;
  }
  return deps.apiKey ? sharedEutilsRateLimiters.withApiKey : sharedEutilsRateLimiters.withoutApiKey;
}

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
   * `esearch` は `retryWithBackoff` の `shouldRetry` にこのフラグを見せて、
   * リトライ対象から除外する（issue #50）。
   */
  readonly permanent: boolean;
  constructor(message: string, status: number, permanent = false) {
    super(message);
    this.name = 'EutilsError';
    this.status = status;
    this.permanent = permanent;
  }
}

/**
 * `retryWithBackoff` の `shouldRetry`: permanent な EutilsError だけリトライ対象から外す。
 * meshRdf.ts の SPARQL 呼び出しからも再利用する（issue #52 レビュー指摘）。
 */
export function shouldRetryEutils(err: unknown): boolean {
  return !(err instanceof EutilsError && err.permanent);
}

/**
 * esearch の JSON レスポンス。NCBI は構文エラー・不明タグ等があっても HTTP 200 を返し、
 * エラーをレスポンス本文に埋め込む（in-band エラー）。`count` だけでなくこれらも見て、
 * 「構文エラー」と「0 件ヒット」を区別する（issue #50）。
 */
interface EsearchResponseJson {
  esearchresult?: {
    count?: string;
    idlist?: string[];
    /** 例: `Empty term and query_key - nothing todo` */
    ERROR?: string;
    errorlist?: {
      /** クォート句が見つからなかった（例: タグの綴り間違い） */
      phrasesnotfound?: string[];
      /** 存在しないフィールドタグ（例: `[tiabb]`） */
      fieldsnotfound?: string[];
    };
    /** stopword 無視等、検索は続行される軽微な警告。エラー扱いしない */
    warninglist?: {
      phrasesignored?: string[];
      quotedphrasesnotfound?: string[];
      outputmessages?: string[];
    };
  };
  /** トップレベルの error（rate limit 超過時の "API rate limit exceeded" 等）。一時エラー扱い */
  error?: string;
}

/**
 * esearch レスポンスの in-band エラー（`ERROR` / `errorlist`）を検査し、
 * あれば permanent な EutilsError を throw する。warninglist は正常系の揺らぎなので無視する。
 */
function assertNoInbandError(json: EsearchResponseJson): void {
  const result = json.esearchresult;
  const fieldsNotFound = result?.errorlist?.fieldsnotfound ?? [];
  const phrasesNotFound = result?.errorlist?.phrasesnotfound ?? [];
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
  const rateLimiter = resolveRateLimiter(deps);

  const json = await retryWithBackoff(
    async () => {
      // リトライ時も含め、実際に HTTP リクエストを発行する直前に毎回トークンを取る。
      // バックオフの待機（既定 1 秒〜）はトークンの補充時間（3〜10 req/s なら数百 ms）より
      // 通常長いため、リトライ時に acquire() が実際に待つことは稀で、二重待機にはならない。
      await rateLimiter.acquire();
      const res = await deps.fetch(url);
      if (!res.ok) {
        throw new EutilsError(`esearch failed: HTTP ${res.status}`, res.status);
      }
      const body = (await res.json()) as EsearchResponseJson;
      if (body.error) {
        // HTTP 200 で返るトップレベル error（rate limit 超過等）。一時エラーなのでリトライ対象
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
  const rateLimiter = resolveRateLimiter(deps);

  const xml = await retryWithBackoff(
    async () => {
      await rateLimiter.acquire();
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
