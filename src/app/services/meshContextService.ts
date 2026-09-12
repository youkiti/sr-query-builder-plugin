import { fetchMeshTreeNumbers, fetchMeshLabels, fetchMeshChildren, type EutilsDeps } from '@/lib/ncbi';
import type { OptimizationMeshRequest, OptimizationMeshNode } from '@/features/formula/skills/optimizeQuery';

/** 最大 3 枝の直下を取得し、通信の境界ごとに停止を確認する。 */
export async function fetchMeshContext(
  request: Readonly<OptimizationMeshRequest>,
  eutils: EutilsDeps,
  check: () => void = () => undefined
): Promise<OptimizationMeshNode[]> {
  const bounded: EutilsDeps = { ...eutils, maxRetries: 1 };
  check();
  const branches = request.treeNumber ? [request.treeNumber]
    : (await fetchMeshTreeNumbers([request.descriptor], bounded)).get(request.descriptor) ?? [];
  check();
  const nodes = new Map<string, OptimizationMeshNode>();
  // 追加取得は最大 3 枝の直下まで。未取得の祖先・子孫を関係として補わない。
  for (const branch of branches.slice(0, 3)) {
    const labels = await fetchMeshLabels([branch], bounded);
    check();
    const children = await fetchMeshChildren(branch, bounded);
    check();
    const parent = labels.get(branch);
    for (const node of [...labels.values(), ...children]) {
      const previous = nodes.get(node.descriptorUi);
      const parentIds = node.treeNumber === branch || !parent ? [] : [parent.descriptorUi];
      const childIds = node.treeNumber === branch ? children.map((child) => child.descriptorUi) : [];
      nodes.set(node.descriptorUi, { id: node.descriptorUi, descriptor: node.label, label: node.label,
        treeNumbers: [...new Set([...(previous?.treeNumbers ?? []), node.treeNumber])],
        parentIds: [...new Set([...(previous?.parentIds ?? []), ...parentIds])],
        childIds: [...new Set([...(previous?.childIds ?? []), ...childIds])], explode: true,
        note: '最大 3 枝の直下のみ取得。その他の親子関係は未取得。',
      });
    }
  }
  return [...nodes.values()];
}
