import type { EutilsDeps } from './eutils';
import { EutilsError } from './eutils';
import { retryWithBackoff } from './rateLimit';

/**
 * NCBI `db=mesh` を叩いて、各 MeSH descriptor の tree number を取得する。
 *
 * - `esearch db=mesh&term=<descriptor>[mh]` で UID を 1 件に解決
 * - `efetch db=mesh&id=<UIDs>` をバッチで 1 回だけ呼び、XML をパース
 * - TreeNumber は 1 descriptor に 0〜複数個。全件を保持する
 *
 * PubMed 側の `efetch db=pubmed` の XML は DescriptorName を返すのみで
 * TreeNumber は入っていないため、階層可視化には別途この関数が必要。
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
    retmode: 'xml',
  });
  appendCommonParams(params, deps);
  const url = `${BASE_URL}/efetch.fcgi?${params.toString()}`;
  const xml = await retryWithBackoff(
    async () => {
      const res = await deps.fetch(url);
      if (!res.ok) {
        throw new EutilsError(`mesh efetch failed: HTTP ${res.status}`, res.status);
      }
      return await res.text();
    },
    { sleep: deps.sleep, maxRetries: deps.maxRetries ?? 5 }
  );

  // MeSH の efetch XML は DescriptorRecord/DescriptorName/String + TreeNumberList/TreeNumber の
  // 構造。一括 id の場合は DescriptorRecordSet 下に複数 DescriptorRecord が並ぶ。
  const records = parseMeshTreeXml(xml);
  for (const record of records) {
    if (record.descriptor !== null) {
      result.set(record.descriptor, record.treeNumbers);
    }
  }
  return result;
}

export interface MeshTreeRecord {
  descriptor: string | null;
  treeNumbers: string[];
}

export function parseMeshTreeXml(xml: string): MeshTreeRecord[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, 'text/xml');
  const out: MeshTreeRecord[] = [];
  for (const record of Array.from(doc.getElementsByTagName('DescriptorRecord'))) {
    const nameEl = record.getElementsByTagName('DescriptorName')[0];
    const descriptor = nameEl?.getElementsByTagName('String')[0]?.textContent?.trim() ?? null;
    const treeNumbers: string[] = [];
    for (const tn of Array.from(record.getElementsByTagName('TreeNumber'))) {
      const text = tn.textContent?.trim();
      if (text) {
        treeNumbers.push(text);
      }
    }
    out.push({ descriptor, treeNumbers });
  }
  return out;
}
