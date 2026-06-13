import type { EutilsDeps, MeshHeadingDetail } from '@/lib/ncbi';
import { efetchArticles } from '@/lib/ncbi';

/**
 * seed PMID 一覧から MeSH 記述子を取り出す。
 * requirements.md §4.6 の `mesh` 検証 / §4.4 の mesh-suggester skill で使う。
 */
export interface MeshForSeed {
  pmid: string;
  title: string | null;
  meshHeadings: string[];
  /** MajorTopic / qualifier を含む構造化 MeSH（meshHeadings と同順） */
  meshDetails: MeshHeadingDetail[];
}

export async function extractMeshForSeeds(
  pmids: readonly string[],
  deps: EutilsDeps
): Promise<MeshForSeed[]> {
  if (pmids.length === 0) {
    return [];
  }
  const articles = await efetchArticles([...pmids], deps);
  return articles.map((a) => ({
    pmid: a.pmid,
    title: a.title,
    meshHeadings: a.meshHeadings,
    meshDetails: a.meshDetails,
  }));
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

/**
 * MeSH の「チェックタグ」群。論文の属性（種・性別・年齢層など）を表す索引語で、
 * ほぼ全論文に付くため概念ブロックの設計には使わない。本表から分離して参考扱いにする。
 * https://www.nlm.nih.gov/mesh/checktags.html を基準にした集合。
 */
const CHECK_TAGS = new Set<string>([
  'Humans',
  'Animals',
  'Male',
  'Female',
  'Adult',
  'Aged',
  'Aged, 80 and over',
  'Middle Aged',
  'Young Adult',
  'Adolescent',
  'Child',
  'Child, Preschool',
  'Infant',
  'Infant, Newborn',
  'Pregnancy',
  'History, Ancient',
  'History, Medieval',
  'History, 15th Century',
  'History, 16th Century',
  'History, 17th Century',
  'History, 18th Century',
  'History, 19th Century',
  'History, 20th Century',
  'History, 21st Century',
]);

export function isMeshCheckTag(descriptor: string): boolean {
  return CHECK_TAGS.has(descriptor);
}

/** seed 全体での 1 つの qualifier(subheading) の付与頻度。 */
export interface SeedMeshQualifier {
  name: string;
  count: number;
}

/** seed 全体での 1 つの MeSH descriptor の集計。 */
export interface SeedMeshConcept {
  descriptor: string;
  /** この descriptor が付与された seed 件数（カバレッジの分子） */
  count: number;
  /** うち MajorTopic として索引された seed 件数 */
  majorCount: number;
  /** 付与された qualifier の頻度（多い順） */
  qualifiers: SeedMeshQualifier[];
}

/**
 * mesh-suggester に渡す seed MeSH の要約。
 * concepts はカバレッジ（count / seedCount）で感度を判断でき、
 * checkTags は概念設計から除外すべき索引語として分離してある。
 */
export interface SeedMeshSummary {
  /** 集計対象の適格 seed 件数（カバレッジの分母） */
  seedCount: number;
  concepts: SeedMeshConcept[];
  checkTags: Array<{ descriptor: string; count: number }>;
}

/**
 * seed の構造化 MeSH を、カバレッジ・MajorTopic・qualifier 付きで集計する。
 * 1 論文内で同じ descriptor が複数回出ても seed 件数としては 1 と数える。
 */
export function summarizeSeedMesh(
  records: readonly MeshForSeed[],
  seedCount: number
): SeedMeshSummary {
  interface Acc {
    count: number;
    majorCount: number;
    qualifiers: Map<string, number>;
  }
  const concepts = new Map<string, Acc>();
  const checkTags = new Map<string, number>();

  for (const record of records) {
    // 1 論文内の重複 descriptor を畳む（カバレッジは論文単位）。
    const seen = new Map<string, MeshHeadingDetail>();
    for (const detail of record.meshDetails) {
      const prev = seen.get(detail.descriptor);
      if (!prev) {
        seen.set(detail.descriptor, detail);
      } else if (detail.majorTopic && !prev.majorTopic) {
        // 同一論文に major/minor 両方あれば major を優先
        seen.set(detail.descriptor, { ...prev, majorTopic: true });
      }
    }
    for (const detail of seen.values()) {
      if (isMeshCheckTag(detail.descriptor)) {
        checkTags.set(detail.descriptor, (checkTags.get(detail.descriptor) ?? 0) + 1);
        continue;
      }
      const acc = concepts.get(detail.descriptor) ?? {
        count: 0,
        majorCount: 0,
        qualifiers: new Map<string, number>(),
      };
      acc.count += 1;
      if (detail.majorTopic) {
        acc.majorCount += 1;
      }
      for (const q of detail.qualifiers) {
        acc.qualifiers.set(q.name, (acc.qualifiers.get(q.name) ?? 0) + 1);
      }
      concepts.set(detail.descriptor, acc);
    }
  }

  const sortByCountThenName = <T extends { descriptor: string; count: number }>(
    a: T,
    b: T
  ): number => {
    if (b.count !== a.count) return b.count - a.count;
    return a.descriptor.localeCompare(b.descriptor);
  };

  return {
    seedCount,
    concepts: Array.from(concepts.entries())
      .map(([descriptor, acc]) => ({
        descriptor,
        count: acc.count,
        majorCount: acc.majorCount,
        qualifiers: Array.from(acc.qualifiers.entries())
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.name.localeCompare(b.name))),
      }))
      .sort(sortByCountThenName),
    checkTags: Array.from(checkTags.entries())
      .map(([descriptor, count]) => ({ descriptor, count }))
      .sort(sortByCountThenName),
  };
}
