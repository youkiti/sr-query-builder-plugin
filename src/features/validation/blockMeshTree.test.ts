import { buildBlockMeshTree, meshCategoryName, type BlockMeshTermInput } from './blockMeshTree';

function t(descriptor: string, explode: boolean, treeNumbers: string[]): BlockMeshTermInput {
  return { descriptor, explode, treeNumbers };
}

describe('buildBlockMeshTree', () => {
  test('tree number が無い用語は unresolved に入りツリーから外れる', () => {
    const res = buildBlockMeshTree([t('Asthma', true, ['C08.127.108']), t('FooBar', true, [])]);
    expect(res.unresolved).toEqual(['FooBar']);
    expect(res.termMeta.has('FooBar')).toBe(false);
    expect(res.termMeta.has('Asthma')).toBe(true);
  });

  test('祖先 explode 用語の子孫は subsumedBy に祖先が入る', () => {
    // Lung Diseases (C08.381) が explode され、Pneumonia (C08.381.677) はその子孫
    const res = buildBlockMeshTree([
      t('Lung Diseases', true, ['C08.381']),
      t('Pneumonia', true, ['C08.381.677']),
    ]);
    expect(res.termMeta.get('Pneumonia')?.subsumedBy).toEqual(['Lung Diseases']);
    // 親側は包含されない
    expect(res.termMeta.get('Lung Diseases')?.subsumedBy).toEqual([]);
  });

  test('祖先が非 explode なら subsumption は成立しない', () => {
    const res = buildBlockMeshTree([
      t('Lung Diseases', false, ['C08.381']),
      t('Pneumonia', true, ['C08.381.677']),
    ]);
    expect(res.termMeta.get('Pneumonia')?.subsumedBy).toEqual([]);
  });

  test('兄弟関係（同じ親の別ノード）は subsumption にならない', () => {
    const res = buildBlockMeshTree([
      t('Asthma', true, ['C08.127.108']),
      t('Bronchitis', true, ['C08.127.200']),
    ]);
    expect(res.termMeta.get('Asthma')?.subsumedBy).toEqual([]);
    expect(res.termMeta.get('Bronchitis')?.subsumedBy).toEqual([]);
  });

  test('別カテゴリに分散していると categories が複数になる', () => {
    const res = buildBlockMeshTree([
      t('Asthma', true, ['C08.127.108']),
      t('Anxiety', true, ['F03.080.725']),
    ]);
    expect(res.categories).toEqual(['C', 'F']);
  });

  test('同じ枝に固まっていれば categories は 1 つ', () => {
    const res = buildBlockMeshTree([
      t('Asthma', true, ['C08.127.108']),
      t('Bronchitis', true, ['C08.127.200']),
    ]);
    expect(res.categories).toEqual(['C']);
  });

  test('nodes はルート先祖まで展開される', () => {
    const res = buildBlockMeshTree([t('Asthma', true, ['C08.127.108'])]);
    const ids = res.nodes.map((n) => n.treeId);
    expect(ids).toContain('C');
    expect(ids).toContain('C08');
    expect(ids).toContain('C08.127');
    expect(ids).toContain('C08.127.108');
  });
});

describe('buildBlockMeshTree.coherent', () => {
  test('C と F の両カテゴリに載る 1 語のみなら coherent は true（categories は分散して見える）', () => {
    // 1 descriptor が複数カテゴリに正規に載るのは MeSH では普通のこと（分散ではない）
    const res = buildBlockMeshTree([
      t('Anxiety Disorders', true, ['C10.597.606.150', 'F03.080.100']),
    ]);
    expect(res.categories).toEqual(['C', 'F']);
    expect(res.coherent).toBe(true);
  });

  test('C のみの語と F のみの語では coherent は false', () => {
    const res = buildBlockMeshTree([
      t('Asthma', true, ['C08.127.108']),
      t('Anxiety', true, ['F03.080.725']),
    ]);
    expect(res.categories).toEqual(['C', 'F']);
    expect(res.coherent).toBe(false);
  });

  test('全語が C を共有していれば（片方が C と F にまたがっていても）coherent は true', () => {
    const res = buildBlockMeshTree([
      t('Asthma', true, ['C08.127.108']),
      // Anxiety Disorders は C と F の両方に載るが、C を共有しているので分散扱いにしない
      t('Anxiety Disorders', true, ['C10.597.606.150', 'F03.080.100']),
    ]);
    expect(res.categories).toEqual(['C', 'F']);
    expect(res.coherent).toBe(true);
  });

  test('resolved が 1 件以下なら coherent は true', () => {
    expect(buildBlockMeshTree([]).coherent).toBe(true);
    expect(buildBlockMeshTree([t('Asthma', true, ['C08.127.108'])]).coherent).toBe(true);
  });
});

describe('meshCategoryName', () => {
  test('既知カテゴリは日本語ラベル', () => {
    expect(meshCategoryName('C')).toBe('疾患');
    expect(meshCategoryName('F')).toBe('精神・行動');
  });
  test('未知カテゴリは letter のまま', () => {
    expect(meshCategoryName('Q')).toBe('Q');
  });
});
