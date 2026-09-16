import type { EutilsDeps } from './eutils';
import { EutilsError, resolveRateLimiter, shouldRetryEutils } from './eutils';
import { retryWithBackoff } from './rateLimit';

/**
 * NCBI `db=mesh` を叩いて、各 MeSH descriptor の tree number を取得する。
 *
 * - `esearch db=mesh&term=<descriptor>[mh]` で候補 UID を最大 20 件取得
 * - `esummary db=mesh&id=<UIDs>&retmode=json` をバッチで 1 回だけ呼び、種別と語が一致する descriptor を選ぶ
 * - TreeNumber は 1 descriptor に 0〜複数個。全件を保持し、未解決なら理由を返す
 *
 * `[mh]` が限定語に翻訳されることもある（例: Incidence → epidemiology[Subheading]）。
 * 別の descriptor の階層を採らないよう、entry term を含む語の一致も確認する。
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
 * 1 descriptor を `db=mesh` で検索し、候補 UID を返す。該当なしは空配列。
 */
async function resolveMeshCandidateUids(descriptor: string, deps: EutilsDeps): Promise<string[]> {
  const params = new URLSearchParams({
    db: 'mesh',
    term: `${descriptor}[mh]`,
    retmode: 'json',
    retmax: '20',
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
  return json.esearchresult?.idlist ?? [];
}

export interface MeshTreeLookup {
  trees: Map<string, string[]>;
  reasons: Map<string, string>;
}

/**
 * MeSH descriptor ごとに、語が一致する唯一の descriptor の tree number を trees に返す。
 * 解決できない語は reasons に理由を返す。両 Map のキーは前後空白を除いた元の表記。
 * 通信失敗は例外として呼び出し側へ伝える。
 *
 * @param descriptors 重複可、空白前後ゆるめ
 */
export async function fetchMeshTreeNumbers(
  descriptors: readonly string[],
  deps: EutilsDeps
): Promise<MeshTreeLookup> {
  const result: MeshTreeLookup = { trees: new Map(), reasons: new Map() };
  const unique = Array.from(new Set(descriptors.map((d) => d.trim()).filter((d) => d !== '')));
  if (unique.length === 0) {
    return result;
  }

  const candidatesByDescriptor = new Map<string, string[]>();
  for (const descriptor of unique) {
    const uids = [...new Set(await resolveMeshCandidateUids(descriptor, deps))];
    candidatesByDescriptor.set(descriptor, uids);
    if (uids.length === 0) result.reasons.set(descriptor, 'db=mesh に該当なし');
  }
  const allUids = [...new Set([...candidatesByDescriptor.values()].flat())];
  if (allUids.length === 0) {
    return result;
  }

  const params = new URLSearchParams({
    db: 'mesh',
    id: allUids.join(','),
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

  const records = parseMeshSummaryRecords(json);
  const treeByUid = parseMeshSummaryJson(json);
  for (const [descriptor, uids] of candidatesByDescriptor) {
    if (uids.length === 0) continue;
    const candidates = uids.flatMap((uid) => {
      const record = records.get(uid);
      return record ? [{ uid, record }] : [];
    });
    if (candidates.length !== uids.length) {
      result.reasons.set(descriptor, '候補の要約が返らなかった');
      continue;
    }
    const descriptors = candidates.filter(({ record }) => record.ds_recordtype === 'descriptor');
    if (descriptors.length === 0) {
      const types = [...new Set(candidates.map(({ record }) => record.ds_recordtype ?? '種別不明'))];
      result.reasons.set(descriptor, `候補 ${candidates.length} 件に descriptor が無い（${summarizeList(types)}）`);
      continue;
    }
    const matching = descriptors.filter(({ record }) => Array.isArray(record.ds_meshterms)
      && record.ds_meshterms.some((term) => typeof term === 'string' && term.trim().toLowerCase() === descriptor.toLowerCase()));
    if (matching.length === 0) {
      result.reasons.set(descriptor, `候補の descriptor が語と一致しない（${summarizeList(descriptors.map(({ record }) => descriptorName(record)))}）`);
      continue;
    }
    if (matching.length > 1) {
      result.reasons.set(descriptor, `語に一致する descriptor が複数ある（${summarizeList(matching.map(({ record }) => descriptorName(record)))}）`);
      continue;
    }
    const treeNumbers = treeByUid.get(matching[0]!.uid);
    if (treeNumbers?.length) result.trees.set(descriptor, treeNumbers);
    else result.reasons.set(descriptor, 'descriptor に tree number が無い');
  }
  return result;
}

function summarizeList(values: string[]): string {
  return values.slice(0, 3).join(', ') + (values.length > 3 ? ', …' : '');
}

function descriptorName(record: MeshSummaryRecord): string {
  const name = Array.isArray(record.ds_meshterms) ? record.ds_meshterms[0] : undefined;
  return typeof name === 'string' && name.trim() ? name.trim() : '名称不明';
}

interface MeshSummaryRecord {
  ds_recordtype?: string;
  ds_meshterms?: unknown[];
  ds_idxlinks?: Array<{ treenum?: string }>;
}

/** esummary db=mesh&retmode=json のうち、descriptor の選別と階層取得に使うフィールド。 */
export interface MeshEsummaryJson {
  result?: {
    uids?: string[];
    [uid: string]: MeshSummaryRecord | string[] | undefined;
  };
}

function parseMeshSummaryRecords(json: MeshEsummaryJson): Map<string, MeshSummaryRecord> {
  const records = new Map<string, MeshSummaryRecord>();
  for (const uid of json.result?.uids ?? []) {
    const record = json.result?.[uid];
    if (record && !Array.isArray(record)) records.set(uid, record);
  }
  return records;
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
