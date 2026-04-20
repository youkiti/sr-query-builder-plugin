/**
 * MeSH tree number の集合から、Mermaid flowchart 用の階層データを組み立てる。
 *
 * tree number は例: `C08.127.108`。`.` 区切りの各成分が 1 階層分に対応する。
 * 先頭 1 文字（アルファベット）が MeSH カテゴリ（A=Anatomy, B=Organisms, C=Diseases, …）。
 *
 * 複数 descriptor が同じ tree number を持つ（例: 同義の 2 語）ことは稀だがあり得るので、
 * ノードは `labels: string[]` で複数 descriptor を保持できる形にする。
 *
 * 参考: https://www.nlm.nih.gov/mesh/meshhome.html のツリー構造仕様
 */

export interface MeshHierarchyNode {
  /** tree number（ルート側の部分文字列が parentId）。 */
  treeId: string;
  /** 親の treeId。カテゴリ letter が親に該当する。トップレベルでは null。 */
  parentId: string | null;
  /** この tree number に結び付く descriptor ラベル（重複可・複数可）。 */
  labels: string[];
}

/**
 * `Map<descriptor, tree numbers[]>` から、ノード一覧（ルート先祖まで展開済み）を返す。
 *
 * - 各 tree number `C08.127.108` は `C`, `C08`, `C08.127`, `C08.127.108` の 4 ノードを作る
 * - 各ノードの `labels` には、その tree number を直接保有する descriptor だけを入れる
 *   （先祖ノードに子の descriptor はまぶさない）
 * - 同じノードが複数 descriptor から参照されてもユニーク化し、`labels` を結合する
 *
 * 結果はノード ID で安定ソート（ルート→深）して返す。
 */
export function buildMeshHierarchy(
  treeMap: ReadonlyMap<string, readonly string[]>
): MeshHierarchyNode[] {
  const nodes = new Map<string, MeshHierarchyNode>();

  const ensureNode = (treeId: string, parentId: string | null): MeshHierarchyNode => {
    const existing = nodes.get(treeId);
    if (existing !== undefined) {
      return existing;
    }
    const created: MeshHierarchyNode = { treeId, parentId, labels: [] };
    nodes.set(treeId, created);
    return created;
  };

  for (const [descriptor, treeNumbers] of treeMap.entries()) {
    for (const treeNumber of treeNumbers) {
      const parts = treeNumber.split('.');
      // カテゴリ letter（例: C08 なら C）を先にノード化
      const head = parts[0];
      if (head === undefined || head === '') {
        continue;
      }
      const category = head.charAt(0);
      ensureNode(category, null);

      // parts[0] = "C08", parts[1] = "127", ... を累積して作る
      let parentId: string = category;
      let accumulator = '';
      for (let i = 0; i < parts.length; i += 1) {
        const part = parts[i]!;
        accumulator = i === 0 ? part : `${accumulator}.${part}`;
        ensureNode(accumulator, parentId);
        parentId = accumulator;
      }

      const leaf = nodes.get(treeNumber)!;
      if (!leaf.labels.includes(descriptor)) {
        leaf.labels.push(descriptor);
      }
    }
  }

  return Array.from(nodes.values()).sort((a, b) => a.treeId.localeCompare(b.treeId));
}

/**
 * 階層ノード配列から Mermaid `flowchart TD` のソース文字列を作る。
 * ノード ID に使える文字は限定されるので、`C08.127.108` の `.` を `_` に置換する。
 *
 * 空入力では空の flowchart（ヘッダ + プレースホルダノード）を返す。
 */
export function toMermaidFlowchart(nodes: readonly MeshHierarchyNode[]): string {
  const lines: string[] = ['flowchart TD'];
  if (nodes.length === 0) {
    lines.push('  empty["(MeSH 階層なし)"]');
    return lines.join('\n');
  }
  // ノード定義
  for (const node of nodes) {
    const id = escapeMermaidId(node.treeId);
    const label = buildNodeLabel(node);
    lines.push(`  ${id}["${label}"]`);
  }
  // エッジ定義
  for (const node of nodes) {
    if (node.parentId !== null) {
      const from = escapeMermaidId(node.parentId);
      const to = escapeMermaidId(node.treeId);
      lines.push(`  ${from} --> ${to}`);
    }
  }
  return lines.join('\n');
}

function escapeMermaidId(raw: string): string {
  return raw.replace(/\./g, '_');
}

function buildNodeLabel(node: MeshHierarchyNode): string {
  const base = escapeMermaidLabel(node.treeId);
  if (node.labels.length === 0) {
    return base;
  }
  const descriptors = node.labels.map(escapeMermaidLabel).join(', ');
  return `${base}<br/>${descriptors}`;
}

function escapeMermaidLabel(raw: string): string {
  return raw.replace(/"/g, '&quot;');
}
