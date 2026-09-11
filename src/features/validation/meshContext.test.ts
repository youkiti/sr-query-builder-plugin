import {
  buildBlockMeshContext, buildMeshBranchPath,
} from './meshContext';

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

test('祖先経路からカテゴリ文字と起点だけを除く', () => {
  expect(buildMeshBranchPath('C01.050')).toEqual({
    spine: ['C', 'C01', 'C01.050'], ancestors: ['C01'],
  });
  expect(buildMeshBranchPath('C01')).toEqual({ spine: ['C', 'C01'], ancestors: [] });
});
