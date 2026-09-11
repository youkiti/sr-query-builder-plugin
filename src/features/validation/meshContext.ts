import type { MeshTreeNode } from '@/lib/ncbi';
import { buildBlockMeshTree, type BlockMeshTreeResult, type MeshTreeEntry } from './blockMeshTree';
import { spineTreeNumbers, type ParsedMeshTerm } from './blockTerms';

export interface BlockMeshContext {
  treeByDescriptor: Map<string, string[]>;
  analysis: BlockMeshTreeResult;
}

/** 取得方法・キャッシュに依存せず、全ての枝と包含関係・未解決語を組み立てる。取得失敗は呼び出し元へ返す。 */
export async function buildBlockMeshContext(
  terms: readonly ParsedMeshTerm[],
  fetchTrees: (descriptors: string[]) => Promise<MeshTreeEntry[]>
): Promise<BlockMeshContext> {
  const entries = await fetchTrees(terms.map((term) => term.descriptor));
  const treeByDescriptor = new Map(entries.map((entry) => [entry.descriptor, entry.treeNumbers]));
  const analysis = buildBlockMeshTree(terms.map((term) => ({
    ...term,
    treeNumbers: treeByDescriptor.get(term.descriptor) ?? [],
  })));
  return { treeByDescriptor, analysis };
}

export interface MeshBranchPath {
  spine: string[];
  ancestors: string[];
}

/** 描画経路とラベル取得対象を一緒に求める。カテゴリ文字と起点自身は取得対象から除く。 */
export function buildMeshBranchPath(treeNumber: string): MeshBranchPath {
  const spine = spineTreeNumbers(treeNumber);
  return { spine, ancestors: spine.slice(1, -1) };
}

export interface MeshBranchContext extends MeshBranchPath {
  /** 空 Map は祖先なし、または名前が未解決。未取得の MeshBranchPath にはこのフィールドがない。 */
  labels: Map<string, MeshTreeNode>;
}

/** 算出済みの経路に祖先ラベルを付ける。取得失敗は空 Map に変換せず例外で返す。 */
export async function buildMeshBranchContext(
  path: MeshBranchPath,
  fetchLabels: (treeNumbers: string[]) => Promise<Map<string, MeshTreeNode>>
): Promise<MeshBranchContext> {
  const labels = path.ancestors.length > 0
    ? await fetchLabels(path.ancestors)
    : new Map<string, MeshTreeNode>();
  return { ...path, labels };
}

export interface MeshChildrenContext {
  treeNumber: string;
  /** 空配列は取得済みの子なし。未取得の場合はコンテクスト自体を作らない。 */
  children: MeshTreeNode[];
}

/** 直下の子だけを取得し、取得元の tree number に紐づける。失敗は例外で返す。 */
export async function buildMeshChildrenContext(
  treeNumber: string,
  fetchChildren: (treeNumber: string) => Promise<MeshTreeNode[]>
): Promise<MeshChildrenContext> {
  return { treeNumber, children: await fetchChildren(treeNumber) };
}
