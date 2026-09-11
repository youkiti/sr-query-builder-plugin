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
