import type { EutilsDeps } from './eutils';
import { EutilsError, resolveRateLimiter, shouldRetryEutils } from './eutils';
import { retryWithBackoff } from './rateLimit';

/**
 * NCBI `db=mesh` を叩いて、各 MeSH descriptor の tree number を取得する。
 *
 * - `esearch db=mesh&term=<descriptor>[mh]` で UID を 1 件に解決
 * - `esummary db=mesh&id=<UIDs>&retmode=json` をバッチで 1 回だけ呼び、JSON をパース
 * - TreeNumber は 1 descriptor に 0〜複数個。全件を保持する
 *
 * PubMed 側の `efetch db=pubmed` の XML は DescriptorName を返すのみで
 * TreeNumber は入っていないため、階層可視化には別途この関数が必要。
 *
 * 注意: `efetch db=mesh` は `retmode=xml` を指定しても常に text/plain（ASCII MeSH
 * レコード）を返し XML パースが無言で失敗する。tree number を構造化取得できるのは
 * `esummary db=mesh&retmode=json` の `ds_idxlinks[].treenum` 経由のみ。
 *
 * レート制御（issue #59 / #58 chunk 3a フォローアップ）: ここは `eutils.ts` の `esearch` /
 * `efetchArticles` とまったく同じホスト（`eutils.ncbi.nlm.nih.gov`）を叩くため、NCBI 側では
 * 同じ 3（キー無し）/10（キー有り）req/s の枠を共有している。`resolveRateLimiter` を
 * `eutils.ts` から再利用して発行前に `acquire()` することで、`sharedEutilsRateLimiters` の
 * 同じバケットを消費させる（新規バケットを作ると枠が分裂し、`esearch` 側が守っていたはずの
 * 上限を `mesh.ts` 分だけ超過してしまう。ブロック・インスペクタの MeSH ツリー取得は
 * distinct descriptor ごとに逐次 esearch するため、この経路が最もバーストしやすい）。
 */

const BASE_URL = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const DEFAULT_TOOL = 'sr-query-builder-plugin';

export type MeshResolution = { status: 'resolved'; headings: string[] } | { status: 'missing' } | { status: 'unknown' };

/** 同義語を正式な見出しへ解決し、照会失敗は unknown として候補を残す。 */
export async function resolveMeshDescriptors(
  descriptors: readonly string[], deps: EutilsDeps
): Promise<Map<string, MeshResolution>> {
  const result = new Map<string, MeshResolution>();
  const request = async (endpoint: string, params: URLSearchParams): Promise<unknown> => {
    appendCommonParams(params, deps);
    return retryWithBackoff(async () => {
      await resolveRateLimiter(deps).acquire();
      const res = await deps.fetch(`${BASE_URL}/${endpoint}.fcgi?${params.toString()}`);
      if (!res.ok) throw new EutilsError(`MeSH 辞書の照会に失敗しました: HTTP ${res.status}`, res.status);
      return res.json();
    }, { sleep: deps.sleep, maxRetries: deps.maxRetries ?? 5, shouldRetry: shouldRetryEutils });
  };
  for (const descriptor of new Set(descriptors.map((value) => value.trim()).filter(Boolean))) {
    result.set(descriptor, { status: 'unknown' });
    try {
      for (const quoted of [true, false]) {
        const json = await request('esearch', new URLSearchParams({ db: 'mesh',
          term: quoted ? `"${descriptor}"[mh]` : `${descriptor}[mh]`, retmode: 'json', retmax: '20' })) as {
          ERROR?: unknown;
          esearchresult?: { ERROR?: unknown; count?: unknown; idlist?: string[];
            errorlist?: { phrasesnotfound?: string[]; fieldsnotfound?: string[] } };
        };
        const search = json.esearchresult;
        if (json.ERROR !== undefined || !search || search.ERROR !== undefined || search.errorlist?.fieldsnotfound?.length) break;
        if (!quoted && search.errorlist?.phrasesnotfound?.length) {
          result.set(descriptor, { status: 'missing' });
          break;
        }
        if (typeof search.count !== 'string' || !/^\d+$/.test(search.count) || !Number.isSafeInteger(Number(search.count))) break;
        if (Number(search.count) === 0) {
          if (quoted) continue;
          result.set(descriptor, { status: 'missing' });
          break;
        }
        if (!Array.isArray(search.idlist) || !search.idlist.length) break;
        const summary = await request('esummary', new URLSearchParams({ db: 'mesh',
          id: search.idlist.join(','), retmode: 'json' })) as {
          ERROR?: unknown;
          result?: { ERROR?: unknown; uids?: string[]; [uid: string]: unknown };
        };
        if (summary.ERROR !== undefined || !summary.result || summary.result.ERROR !== undefined || !Array.isArray(summary.result.uids)) break;
        const headings = new Set<string>();
        for (const uid of summary.result.uids ?? []) {
          const record = summary.result[uid] as { ds_recordtype?: string; ds_meshterms?: unknown[]; error?: unknown; ERROR?: unknown } | undefined;
          if (record?.error !== undefined || record?.ERROR !== undefined) throw new Error('MeSH の要約取得に失敗しました');
          const heading = record?.ds_recordtype === 'descriptor' && Array.isArray(record.ds_meshterms) ? record.ds_meshterms[0] : undefined;
          if (typeof heading === 'string' && heading.trim()) headings.add(heading.trim());
        }
        if (headings.size) result.set(descriptor, { status: 'resolved', headings: [...headings] });
        break;
      }
    } catch {
      // 通信失敗や不正な応答でも生成を止めず、候補を残す。
    }
  }
  return result;
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

/**
 * 1 descriptor を `db=mesh` で検索して UID を返す。1 件にヒットしなかったら null。
 */
async function resolveMeshUid(descriptor: string, deps: EutilsDeps): Promise<string | null> {
  const params = new URLSearchParams({
    db: 'mesh',
    term: `${descriptor}[mh]`,
    retmode: 'json',
    retmax: '2',
  });
  appendCommonParams(params, deps);
  const url = `${BASE_URL}/esearch.fcgi?${params.toString()}`;
  const rateLimiter = resolveRateLimiter(deps);
  const json = await retryWithBackoff(
    async () => {
      // esearch.ts と同じく、リトライ時も含め実際に HTTP リクエストを発行する直前に
      // 毎回トークンを取る（issue #59 と同じ流儀）。
      await rateLimiter.acquire();
      const res = await deps.fetch(url);
      if (!res.ok) {
        throw new EutilsError(`mesh esearch failed: HTTP ${res.status}`, res.status);
      }
      return (await res.json()) as { esearchresult?: { idlist?: string[] } };
    },
    { sleep: deps.sleep, maxRetries: deps.maxRetries ?? 5 }
  );
  const ids = json.esearchresult?.idlist ?? [];
  const [first] = ids;
  if (ids.length === 1 && first !== undefined) {
    return first;
  }
  return null;
}

/**
 * MeSH descriptor の配列 → Map<descriptor, tree numbers[]> を返す。
 * descriptor が解決できなかった場合はエントリが入らない（Map に存在しない）。
 *
 * @param descriptors 重複可、空白前後ゆるめ
 */
export async function fetchMeshTreeNumbers(
  descriptors: readonly string[],
  deps: EutilsDeps
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  const unique = Array.from(new Set(descriptors.map((d) => d.trim()).filter((d) => d !== '')));
  if (unique.length === 0) {
    return result;
  }

  const uidToDescriptor = new Map<string, string>();
  for (const descriptor of unique) {
    const uid = await resolveMeshUid(descriptor, deps);
    if (uid !== null) {
      uidToDescriptor.set(uid, descriptor);
    }
  }
  if (uidToDescriptor.size === 0) {
    return result;
  }

  const params = new URLSearchParams({
    db: 'mesh',
    id: Array.from(uidToDescriptor.keys()).join(','),
    retmode: 'json',
  });
  appendCommonParams(params, deps);
  const url = `${BASE_URL}/esummary.fcgi?${params.toString()}`;
  const rateLimiter = resolveRateLimiter(deps);
  const json = await retryWithBackoff(
    async () => {
      await rateLimiter.acquire();
      const res = await deps.fetch(url);
      if (!res.ok) {
        throw new EutilsError(`mesh esummary failed: HTTP ${res.status}`, res.status);
      }
      return (await res.json()) as MeshEsummaryJson;
    },
    { sleep: deps.sleep, maxRetries: deps.maxRetries ?? 5 }
  );

  // esummary db=mesh の JSON は result[uid].ds_idxlinks[].treenum に tree number を持つ。
  // uid → descriptor は esearch 時に作った uidToDescriptor で逆引きする（名前マッチ不要）。
  const treeByUid = parseMeshSummaryJson(json);
  for (const [uid, descriptor] of uidToDescriptor) {
    const treeNumbers = treeByUid.get(uid);
    if (treeNumbers !== undefined) {
      result.set(descriptor, treeNumbers);
    }
  }
  return result;
}

/** esummary db=mesh&retmode=json のうち、tree number 抽出に使うフィールドだけを表す型。 */
export interface MeshEsummaryJson {
  result?: {
    uids?: string[];
    [uid: string]: { ds_idxlinks?: Array<{ treenum?: string }> } | string[] | undefined;
  };
}

/**
 * esummary db=mesh の JSON から Map<uid, treeNumbers[]> を構築する。
 *
 * - `ds_idxlinks` が空 / 欠落の uid は Map に入れない（呼び出し側で「解決不能」と同じ扱い）
 * - `treenum` が空文字や欠落の要素は除外する
 */
export function parseMeshSummaryJson(json: MeshEsummaryJson): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const result = json.result;
  if (!result) {
    return out;
  }
  for (const uid of result.uids ?? []) {
    const entry = result[uid];
    if (!entry || Array.isArray(entry)) {
      continue;
    }
    const treeNumbers: string[] = [];
    for (const link of entry.ds_idxlinks ?? []) {
      const treenum = link.treenum?.trim();
      if (treenum) {
        treeNumbers.push(treenum);
      }
    }
    if (treeNumbers.length > 0) {
      out.set(uid, treeNumbers);
    }
  }
  return out;
}
