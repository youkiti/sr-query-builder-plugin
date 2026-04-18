import type { EutilsDeps } from '@/lib/ncbi';
import { efetchArticles } from '@/lib/ncbi';

/**
 * seed PMID 一覧から MeSH 記述子を取り出す。
 * requirements.md §4.6 の `mesh` 検証 / §4.4 の mesh-suggester skill で使う。
 */
export interface MeshForSeed {
  pmid: string;
  title: string | null;
  meshHeadings: string[];
}

export async function extractMeshForSeeds(
  pmids: readonly string[],
  deps: EutilsDeps
): Promise<MeshForSeed[]> {
  if (pmids.length === 0) {
    return [];
  }
  const articles = await efetchArticles([...pmids], deps);
  return articles.map((a) => ({ pmid: a.pmid, title: a.title, meshHeadings: a.meshHeadings }));
}

/**
 * 全 seed の MeSH をフラットにまとめ、重複を排除して件数順に並べる。
 * mesh-suggester skill のプロンプトに渡すときに便利。
 */
export function aggregateMeshFrequency(
  records: readonly MeshForSeed[]
): Array<{ descriptor: string; count: number }> {
  const counts = new Map<string, number>();
  for (const record of records) {
    for (const heading of record.meshHeadings) {
      counts.set(heading, (counts.get(heading) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .map(([descriptor, count]) => ({ descriptor, count }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.descriptor.localeCompare(b.descriptor);
    });
}
