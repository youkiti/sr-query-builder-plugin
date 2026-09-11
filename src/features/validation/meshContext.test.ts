import type { MeshTreeNode } from '@/lib/ncbi';
import {
  buildBlockMeshContext, buildMeshBranchPath, buildMeshBranchContext, buildMeshChildrenContext,
} from './meshContext';

const node: MeshTreeNode = { treeNumber: 'C01.100', descriptorUi: 'D1', label: '子', hasChildren: false };

test('全ての枝を保持し、包含関係・NoExp・未解決語を組み立てる', async () => {
  const fetchTrees = jest.fn().mockResolvedValue([
    { descriptor: '親', treeNumbers: ['C01', 'D01'] },
    { descriptor: '子', treeNumbers: ['C01.100'] },
  ]);
  const terms = [
    { descriptor: '親', explode: true }, { descriptor: '子', explode: false }, { descriptor: '不明', explode: true },
  ];
  const context = await buildBlockMeshContext(terms, fetchTrees);
  expect(fetchTrees).toHaveBeenCalledWith(['親', '子', '不明']);
  expect(context.treeByDescriptor.get('親')).toEqual(['C01', 'D01']);
  expect(context.analysis.termMeta.get('子')).toMatchObject({ explode: false, subsumedBy: ['親'] });
  expect(context.analysis.unresolved).toEqual(['不明']);
});

test('空の語集合を扱い、ツリー取得失敗は未解決と混同せず例外で返す', async () => {
  expect((await buildBlockMeshContext([], async () => [])).analysis.nodes).toEqual([]);
  await expect(buildBlockMeshContext([{ descriptor: '語', explode: true }], async () => {
    throw new Error('取得失敗');
  })).rejects.toThrow('取得失敗');
});

test('祖先と直下の子を callback で取得し、取得対象は一段に留める', async () => {
  const labels = new Map([['C01', { ...node, treeNumber: 'C01', label: '親' }]]);
  const fetchLabels = jest.fn().mockResolvedValue(labels);
  const fetchChildren = jest.fn().mockResolvedValue([node]);
  const path = buildMeshBranchPath('C01.050');
  expect(path).toEqual({ spine: ['C', 'C01', 'C01.050'], ancestors: ['C01'] });
  expect(await buildMeshBranchContext(path, fetchLabels)).toEqual({
    ...path, labels,
  });
  expect(await buildMeshChildrenContext('C01.050', fetchChildren)).toEqual({
    treeNumber: 'C01.050', children: [node],
  });
  expect(fetchLabels).toHaveBeenCalledWith(['C01']);
  expect(fetchLabels).toHaveBeenCalledTimes(1);
  expect(fetchChildren).toHaveBeenCalledWith('C01.050');
  expect(fetchChildren).toHaveBeenCalledTimes(1);
});

test('未取得・祖先なし・取得済みの子なしを区別する', async () => {
  const path = buildMeshBranchPath('C01');
  expect(path).toEqual({ spine: ['C', 'C01'], ancestors: [] });
  expect(path).not.toHaveProperty('labels');
  expect(path).not.toHaveProperty('children');
  const fetchLabels = jest.fn();
  expect(await buildMeshBranchContext(path, fetchLabels)).toEqual({
    ...path, labels: new Map(),
  });
  expect(await buildMeshChildrenContext('C01', async () => [])).toEqual({
    treeNumber: 'C01', children: [],
  });
  expect(fetchLabels).not.toHaveBeenCalled();
});

test('祖先ラベルの取得失敗は空の取得結果に変換しない', async () => {
  await expect(buildMeshBranchContext(buildMeshBranchPath('C01.100'), async () => {
    throw new Error('取得失敗');
  })).rejects.toThrow('取得失敗');
});

test('子の取得失敗は空の取得結果に変換しない', async () => {
  await expect(buildMeshChildrenContext('C01.100', async () => {
    throw new Error('取得失敗');
  })).rejects.toThrow('取得失敗');
});
