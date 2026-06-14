import type { EutilsDeps } from './eutils';
import { EutilsError } from './eutils';
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
 */

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
  const json = await retryWithBackoff(
    async () => {
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
  const json = await retryWithBackoff(
    async () => {
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
