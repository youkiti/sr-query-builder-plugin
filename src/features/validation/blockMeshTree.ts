/**
 * 1 ブロック内の MeSH 用語を「MeSH ツリー上のどこに乗っているか」で構造化する。
 *
 * 目的（requirements: ブロック編集インスペクタ）:
 * - **重なり**: ある用語が、同じブロック内の別 explode 用語の子孫になっている（祖先重複=冗長）
 * - **ずれ**: ブロック内の用語が同じ枝に固まっているか、別カテゴリに分散しているか
 *
 * tree number（例 `C08.127.108`）の親子関係は [buildMeshHierarchy](./buildMeshHierarchy.ts) に委譲し、
 * 本モジュールは「ブロック用語としての注釈（explode / 祖先重複）」と「分散カテゴリ集計」を足す。
 */

import { buildMeshHierarchy, type MeshHierarchyNode } from './buildMeshHierarchy';

/** NCBI `db=mesh` で取得した descriptor → tree numbers の対応（callback 戻り値の素の形）。 */
export interface MeshTreeEntry {
  descriptor: string;
  treeNumbers: string[];
}

/** ブロック内 MeSH 用語 1 つ（式から抽出した descriptor と explode 可否 + 解決済み tree numbers）。 */
export interface BlockMeshTermInput {
  descriptor: string;
  /** `[Mesh]` / `[mh]`（explode）か、`[Mesh:NoExp]` / `[mh:noexp]`（非 explode）か */
  explode: boolean;
  treeNumbers: readonly string[];
}

/** ブロック用語ごとの注釈。 */
export interface BlockMeshTermMeta {
  descriptor: string;
  explode: boolean;
  /**
   * このブロック内で、この用語を包含している別用語の descriptor 一覧。
   * 「祖先が explode されている」用語の子孫であるとき、その祖先 descriptor が入る（= 冗長）。
   */
  subsumedBy: string[];
}

export interface BlockMeshTreeResult {
  /** buildMeshHierarchy の出力（ルート先祖まで展開済み・treeId 昇順） */
  nodes: MeshHierarchyNode[];
  /** descriptor → 注釈 */
  termMeta: Map<string, BlockMeshTermMeta>;
  /** ブロック用語が乗っているカテゴリ letter（A, C, F …）の昇順ユニーク一覧 */
  categories: string[];
  /** tree number が解決できなかった descriptor（ツリーに出せない用語） */
  unresolved: string[];
}

/**
 * MeSH カテゴリ letter → 日本語ラベル。ルートノード表示と「ずれ」サマリに使う。
 * NLM MeSH のトップカテゴリ（A〜Z の主要分類）。
 */
const CATEGORY_NAMES: Record<string, string> = {
  A: '解剖',
  B: '生物',
  C: '疾患',
  D: '化学物質・薬物',
  E: '手技・技術',
  F: '精神・行動',
  G: '生命現象',
  H: '学問分野',
  I: '社会',
  J: '工業・技術',
  K: '人文',
  L: '情報',
  M: '人々の集団',
  N: '医療',
  V: '出版特性',
  Z: '地理',
};

/** カテゴリ letter の日本語ラベルを返す（未知の letter はそのまま）。 */
export function meshCategoryName(letter: string): string {
  return CATEGORY_NAMES[letter] ?? letter;
}

/**
 * ブロック用語 + tree numbers から、階層ノードと注釈を組み立てる。
 *
 * - tree numbers が空の用語は `unresolved` に入れ、ツリー構築からは除外する
 * - subsumedBy: 用語 D の tree number のいずれかが、別の explode 用語 A の tree number の
 *   子孫（`<A>.` で始まる）であれば、D は A に包含される
 */
export function buildBlockMeshTree(terms: readonly BlockMeshTermInput[]): BlockMeshTreeResult {
  const resolved = terms.filter((t) => t.treeNumbers.length > 0);
  const unresolved = terms.filter((t) => t.treeNumbers.length === 0).map((t) => t.descriptor);

  // buildMeshHierarchy 用の Map<descriptor, treeNumbers[]>
  const treeMap = new Map<string, string[]>();
  for (const term of resolved) {
    treeMap.set(term.descriptor, [...term.treeNumbers]);
  }
  const nodes = buildMeshHierarchy(treeMap);

  // 祖先重複（subsumption）の算出
  const termMeta = new Map<string, BlockMeshTermMeta>();
  for (const term of resolved) {
    const subsumedBy: string[] = [];
    for (const other of resolved) {
      if (other.descriptor === term.descriptor || !other.explode) {
        continue;
      }
      if (isDescendant(term.treeNumbers, other.treeNumbers)) {
        if (!subsumedBy.includes(other.descriptor)) {
          subsumedBy.push(other.descriptor);
        }
      }
    }
    termMeta.set(term.descriptor, {
      descriptor: term.descriptor,
      explode: term.explode,
      subsumedBy,
    });
  }

  // 分散カテゴリ（用語が乗っている tree number の先頭 letter）
  const categorySet = new Set<string>();
  for (const term of resolved) {
    for (const tn of term.treeNumbers) {
      const letter = tn.charAt(0);
      if (letter !== '') {
        categorySet.add(letter);
      }
    }
  }
  const categories = Array.from(categorySet).sort();

  return { nodes, termMeta, categories, unresolved };
}

/**
 * childTrees のいずれかが parentTrees のいずれかの子孫（`<parent>.` で始まる）なら true。
 * 完全一致は子孫ではない（同一ノードは subsumption に含めない）。
 */
function isDescendant(
  childTrees: readonly string[],
  parentTrees: readonly string[]
): boolean {
  for (const child of childTrees) {
    for (const parent of parentTrees) {
      if (child !== parent && child.startsWith(`${parent}.`)) {
        return true;
      }
    }
  }
  return false;
}
