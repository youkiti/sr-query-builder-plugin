import { buildMeshHierarchy, toMermaidFlowchart } from './buildMeshHierarchy';

describe('buildMeshHierarchy', () => {
  test('空 map なら空配列', () => {
    expect(buildMeshHierarchy(new Map())).toEqual([]);
  });

  test('単一 descriptor + 単一 tree number で、カテゴリから葉まで祖先ノードが全部作られる', () => {
    const treeMap = new Map<string, string[]>([['Asthma', ['C08.127.108']]]);
    const nodes = buildMeshHierarchy(treeMap);
    expect(nodes.map((n) => n.treeId)).toEqual(['C', 'C08', 'C08.127', 'C08.127.108']);
    expect(nodes[0]!.parentId).toBeNull();
    expect(nodes[1]!.parentId).toBe('C');
    expect(nodes[2]!.parentId).toBe('C08');
    expect(nodes[3]!.parentId).toBe('C08.127');
    // ラベルは葉ノードだけに付く
    expect(nodes.find((n) => n.treeId === 'C08.127.108')!.labels).toEqual(['Asthma']);
    expect(nodes.find((n) => n.treeId === 'C08')!.labels).toEqual([]);
  });

  test('同じ tree number に複数 descriptor が付いたら labels が結合される（重複は弾く）', () => {
    const treeMap = new Map<string, string[]>([
      ['DescA', ['D01.001']],
      ['DescB', ['D01.001']],
      // 同じ descriptor を 2 回入れても labels は 1 回だけ
      ['DescA', ['D01.001']],
    ]);
    const nodes = buildMeshHierarchy(treeMap);
    const leaf = nodes.find((n) => n.treeId === 'D01.001')!;
    expect(leaf.labels).toEqual(['DescA', 'DescB']);
  });

  test('複数 tree number を持つ descriptor は両方の祖先系統が作られる', () => {
    const treeMap = new Map<string, string[]>([['Asthma', ['C08.127.108', 'C08.381.495.108']]]);
    const nodes = buildMeshHierarchy(treeMap);
    expect(nodes.map((n) => n.treeId).sort()).toEqual(
      [
        'C',
        'C08',
        'C08.127',
        'C08.127.108',
        'C08.381',
        'C08.381.495',
        'C08.381.495.108',
      ].sort()
    );
    // 2 つの葉に同じ Asthma ラベルが入る
    expect(nodes.find((n) => n.treeId === 'C08.127.108')!.labels).toEqual(['Asthma']);
    expect(nodes.find((n) => n.treeId === 'C08.381.495.108')!.labels).toEqual(['Asthma']);
  });

  test('空文字列の tree number は無視される', () => {
    const treeMap = new Map<string, string[]>([['NoTree', ['']]]);
    expect(buildMeshHierarchy(treeMap)).toEqual([]);
  });
});

describe('toMermaidFlowchart', () => {
  test('空なら flowchart TD + プレースホルダを返す', () => {
    expect(toMermaidFlowchart([])).toBe('flowchart TD\n  empty["(MeSH 階層なし)"]');
  });

  test('ノードとエッジを `flowchart TD` に変換する（. を _ にエスケープ）', () => {
    const nodes = buildMeshHierarchy(new Map([['Asthma', ['C08.127.108']]]));
    const src = toMermaidFlowchart(nodes);
    expect(src.split('\n')[0]).toBe('flowchart TD');
    expect(src).toContain('C08_127_108["C08.127.108<br/>Asthma"]');
    expect(src).toContain('C --> C08');
    expect(src).toContain('C08 --> C08_127');
    expect(src).toContain('C08_127 --> C08_127_108');
  });

  test('ダブルクォートを含む descriptor は &quot; にエスケープする', () => {
    const nodes = buildMeshHierarchy(new Map([['Weird"Name', ['D01.001']]]));
    const src = toMermaidFlowchart(nodes);
    expect(src).toContain('Weird&quot;Name');
  });
});
