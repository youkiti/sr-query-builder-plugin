import { buildBlockInspector, extractBlockTerms, type BlockInspectorParams } from './blockInspector';
import type { MeshTreeEntry } from '@/features/validation';

function buildDoc(): Document {
  return document.implementation.createHTMLDocument('test');
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function baseParams(over: Partial<BlockInspectorParams> = {}): BlockInspectorParams {
  return {
    blockId: '1',
    expression: '"Asthma"[Mesh] OR asthma*[tiab]',
    siblings: [],
    hitsCache: new Map(),
    meshTreeCache: new Map(),
    meshChildrenCache: new Map(),
    meshLabelCache: new Map(),
    freewordDeltaCache: new Map(),
    meshExpandedState: new Map(),
    ...over,
  };
}

describe('extractBlockTerms', () => {
  test('MeSH と freeword を分け、explode 可否を判定する', () => {
    const terms = extractBlockTerms(
      '("Asthma"[Mesh] OR "Pneumonia"[Mesh:NoExp] OR asthma*[tiab] OR wheez*[tiab])'
    );
    expect(terms.meshTerms).toEqual([
      { descriptor: 'Asthma', explode: true },
      { descriptor: 'Pneumonia', explode: false },
    ]);
    expect(terms.freewordTerms.map((t) => t.query)).toEqual(['asthma*[tiab]', 'wheez*[tiab]']);
  });

  test('同じ freeword は重複除去し、MeSH は descriptor で集約（explode は OR）', () => {
    const terms = extractBlockTerms(
      'x[tiab] OR x[tiab] OR "A"[Mesh:NoExp] OR "A"[Mesh]'
    );
    expect(terms.freewordTerms).toHaveLength(1);
    expect(terms.meshTerms).toEqual([{ descriptor: 'A', explode: true }]);
  });

  test('引用符内に and を含む descriptor を分割しない', () => {
    const terms = extractBlockTerms('"Oral and Maxillofacial Surgeons"[Mesh] OR surgeon*[tiab]');
    expect(terms.meshTerms).toEqual([
      { descriptor: 'Oral and Maxillofacial Surgeons', explode: true },
    ]);
    expect(terms.freewordTerms.map((t) => t.query)).toEqual(['surgeon*[tiab]']);
  });
});

describe('buildBlockInspector', () => {
  test('callback が無ければ null を返す', () => {
    const doc = buildDoc();
    const el = buildBlockInspector(doc, baseParams());
    expect(el).toBeNull();
  });

  test('MeSH ブラウザの枝（ルート〜起点）を描き、起点に件数を出す', async () => {
    const doc = buildDoc();
    const onFetchMeshTrees = jest
      .fn<Promise<MeshTreeEntry[]>, [string[]]>()
      .mockResolvedValue([{ descriptor: 'Asthma', treeNumbers: ['C08.127.108'] }]);
    const onCountHits = jest.fn().mockResolvedValue(12300);
    const el = buildBlockInspector(
      doc,
      baseParams({ expression: '"Asthma"[Mesh]', onFetchMeshTrees, onCountHits })
    )!;
    expect(el.querySelector('.bins__loading')).toBeTruthy();
    await flushAsync();
    expect(onFetchMeshTrees).toHaveBeenCalledWith(['Asthma']);
    // ルートはカテゴリ名、起点は descriptor 名 + 起点バッジ
    expect(el.querySelector('.bins__row-cat')?.textContent).toContain('C 疾患');
    const origin = el.querySelector('.bins__row--origin')!;
    expect(origin.querySelector('.bins__row-name')?.textContent).toBe('Asthma');
    expect(origin.querySelector('.bins__badge--origin')?.textContent).toBe('起点');
    // 件数バッジ（"Asthma"[Mesh] で explode count）
    expect(onCountHits).toHaveBeenCalledWith('"Asthma"[Mesh]');
    expect(el.querySelector('.bins__count--done')?.textContent).toBe('12,300 件');
  });

  test('同じ語の枝をグループ化し、「この語を削除」でブロックから外す', async () => {
    const doc = buildDoc();
    // 1 つの descriptor が 2 系統（別カテゴリ）の tree number に乗るケース
    const onFetchMeshTrees = jest.fn().mockResolvedValue([
      { descriptor: 'Surgeons', treeNumbers: ['M01.526.485.810.910', 'N02.360.140'] },
    ]);
    const onApplyExpression = jest.fn();
    const el = buildBlockInspector(
      doc,
      baseParams({
        expression: '"Surgeons"[Mesh] OR surgeon*[tiab]',
        onFetchMeshTrees,
        onCountHits: jest.fn().mockResolvedValue(1),
        onApplyExpression,
      })
    )!;
    await flushAsync();
    // 1 descriptor = 1 グループ、2 tree number = 2 枝
    const groups = el.querySelectorAll('.bins__group');
    expect(groups).toHaveLength(1);
    expect(groups[0]!.querySelector('.bins__group-name')?.textContent).toBe('Surgeons');
    expect(groups[0]!.querySelectorAll('.bins__branch')).toHaveLength(2);
    // 複数系統バッジ
    expect(groups[0]!.querySelector('.bins__badge--multi')?.textContent).toBe('2 系統');
    // 削除はフリーワードを残して MeSH 句だけ外す
    groups[0]!.querySelector<HTMLButtonElement>('.bins__group-delete')!.click();
    expect(onApplyExpression).toHaveBeenCalledWith('surgeon*[tiab]');
  });

  test('ブロック内 MeSH の冗長（内包）を 1 行で示す', async () => {
    const doc = buildDoc();
    const onFetchMeshTrees = jest.fn().mockResolvedValue([
      { descriptor: 'Lung Diseases', treeNumbers: ['C08.381'] },
      { descriptor: 'Pneumonia', treeNumbers: ['C08.381.677'] },
    ]);
    const el = buildBlockInspector(
      doc,
      baseParams({
        expression: '"Lung Diseases"[Mesh] OR "Pneumonia"[Mesh]',
        onFetchMeshTrees,
      })
    )!;
    await flushAsync();
    const body = el.querySelector('.bins__mesh-body')!.textContent ?? '';
    expect(body).toContain('冗長');
    expect(body).toContain('Pneumonia');
    expect(body).toContain('Lung Diseases配下');
  });

  test('別カテゴリに分散していると分散サマリを出す', async () => {
    const doc = buildDoc();
    const onFetchMeshTrees = jest.fn().mockResolvedValue([
      { descriptor: 'Asthma', treeNumbers: ['C08.127.108'] },
      { descriptor: 'Anxiety', treeNumbers: ['F03.080'] },
    ]);
    const el = buildBlockInspector(
      doc,
      baseParams({ expression: '"Asthma"[Mesh] OR "Anxiety"[Mesh]', onFetchMeshTrees })
    )!;
    await flushAsync();
    const div = el.querySelector('.bins__divergence--spread');
    expect(div?.textContent).toContain('2 カテゴリに分散');
    expect(div?.textContent).toContain('C 疾患');
    expect(div?.textContent).toContain('F 精神・行動');
  });

  test('フリーワード Δ 表を個別降順で描画し、内包語を削除候補にする', async () => {
    const doc = buildDoc();
    // a* 個別 100、asthmatic 個別 80 だが a* に内包（累積 OR=100, Δ=0）
    const onCountHits = jest.fn((q: string) => {
      if (q === 'a*[tiab]') return Promise.resolve(100);
      if (q === 'asthmatic[tiab]') return Promise.resolve(80);
      if (q.includes(' OR ')) return Promise.resolve(100); // 累積 = a* のまま
      return Promise.resolve(0);
    });
    const el = buildBlockInspector(
      doc,
      baseParams({ expression: 'a*[tiab] OR asthmatic[tiab]', onCountHits })
    )!;
    await flushAsync();
    const rows = el.querySelectorAll('.bins__delta-row');
    expect(rows).toHaveLength(2);
    // 個別降順: a*(100) → asthmatic(80)
    expect(rows[0]!.querySelector('.bins__delta-term')?.textContent).toBe('a*[tiab]');
    expect(rows[1]!.querySelector('.bins__delta-term')?.textContent).toBe('asthmatic[tiab]');
    // 2 行目は Δ=0 で削除候補
    expect(rows[1]!.className).toContain('bins__delta-row--redundant');
    expect(rows[1]!.querySelector('.bins__delta-flag')?.textContent).toContain('削除候補');
    expect(el.querySelector('.bins__delta-total')?.textContent).toContain('100 件');
  });

  test('ヒット0 の語は綴り確認フラグを出す', async () => {
    const doc = buildDoc();
    const onCountHits = jest.fn((q: string) =>
      Promise.resolve(q === 'good[tiab]' ? 10 : 0)
    );
    const el = buildBlockInspector(
      doc,
      baseParams({ expression: 'good[tiab] OR "reactive airway"[tiab]', onCountHits })
    )!;
    await flushAsync();
    const flags = Array.from(el.querySelectorAll('.bins__delta-flag')).map((f) => f.textContent);
    expect(flags.some((f) => f?.includes('ヒット0'))).toBe(true);
  });

  test('onApplyExpression 注入時、Δ 行に語編集ボタンと × 削除を出す', async () => {
    const doc = buildDoc();
    const onCountHits = jest.fn((q: string) => {
      if (q === 'surgeon*[tiab]') return Promise.resolve(300);
      if (q === 'neurosurgeon*[tiab]') return Promise.resolve(15);
      return Promise.resolve(310);
    });
    const el = buildBlockInspector(
      doc,
      baseParams({
        expression: 'surgeon*[tiab] OR neurosurgeon*[tiab]',
        onCountHits,
        onApplyExpression: jest.fn(),
      })
    )!;
    await flushAsync();
    const rows = el.querySelectorAll('.bins__delta-row');
    expect(rows[0]!.querySelector('.bins__delta-term-btn')).toBeTruthy();
    expect(rows[0]!.querySelector('.bins__delta-remove')).toBeTruthy();
  });

  test('onApplyExpression 未注入なら Δ 行は静的表示（編集ボタンを出さない）', async () => {
    const doc = buildDoc();
    const onCountHits = jest.fn((q: string) => Promise.resolve(q.includes('OR') ? 10 : 5));
    const el = buildBlockInspector(
      doc,
      baseParams({ expression: 'a[tiab] OR b[tiab]', onCountHits })
    )!;
    await flushAsync();
    expect(el.querySelector('.bins__delta-term-btn')).toBeNull();
    expect(el.querySelector('.bins__delta-remove')).toBeNull();
  });

  test('Δ 行の × でその語を式から外して onApplyExpression に渡す', async () => {
    const doc = buildDoc();
    const onCountHits = jest.fn((q: string) => {
      if (q === 'surgeon*[tiab]') return Promise.resolve(300);
      if (q === 'neurosurgeon*[tiab]') return Promise.resolve(15);
      return Promise.resolve(310);
    });
    const onApplyExpression = jest.fn();
    const el = buildBlockInspector(
      doc,
      baseParams({
        expression: 'surgeon*[tiab] OR neurosurgeon*[tiab]',
        onCountHits,
        onApplyExpression,
      })
    )!;
    await flushAsync();
    // 2 行目（neurosurgeon*）の × を押す
    const rows = el.querySelectorAll('.bins__delta-row');
    rows[1]!.querySelector<HTMLButtonElement>('.bins__delta-remove')!.click();
    expect(onApplyExpression).toHaveBeenCalledWith('surgeon*[tiab]');
  });

  test('Δ 行の語クリック→編集で語だけ差し替える（タグ保持）', async () => {
    const doc = buildDoc();
    const onCountHits = jest.fn((q: string) => {
      if (q === 'surgeon*[tiab]') return Promise.resolve(300);
      if (q === 'neurosurgeon*[tiab]') return Promise.resolve(15);
      return Promise.resolve(310);
    });
    const onApplyExpression = jest.fn();
    const el = buildBlockInspector(
      doc,
      baseParams({
        expression: 'surgeon*[tiab] OR neurosurgeon*[tiab]',
        onCountHits,
        onApplyExpression,
      })
    )!;
    await flushAsync();
    const rows = el.querySelectorAll('.bins__delta-row');
    // 1 行目（surgeon*）の語を編集
    rows[0]!.querySelector<HTMLButtonElement>('.bins__delta-term-btn')!.click();
    const input = rows[0]!.querySelector<HTMLInputElement>('.bins__delta-input')!;
    expect(input.value).toBe('surgeon*'); // タグを除いた語
    input.value = 'surgeons*';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(onApplyExpression).toHaveBeenCalledWith('surgeons*[tiab] OR neurosurgeon*[tiab]');
  });

  test('他ブロックと共有する語を重複行で示す', () => {
    const doc = buildDoc();
    const el = buildBlockInspector(
      doc,
      baseParams({
        expression: '"Pneumonia"[Mesh] OR cough[tiab]',
        onCountHits: jest.fn().mockResolvedValue(1),
        siblings: [{ id: '2', label: 'Outcome', expression: '"Pneumonia"[Mesh] OR fever[tiab]' }],
      })
    )!;
    const overlap = el.querySelector('.bins__overlap-line');
    expect(overlap?.textContent).toContain('#2 Outcome と共有');
    expect(overlap?.textContent).toContain('Pneumonia');
  });

  test('他ブロックと重複が無ければその旨を出す', () => {
    const doc = buildDoc();
    const el = buildBlockInspector(
      doc,
      baseParams({
        expression: 'cough[tiab]',
        onCountHits: jest.fn().mockResolvedValue(1),
        siblings: [{ id: '2', label: 'Outcome', expression: 'fever[tiab]' }],
      })
    )!;
    expect(el.querySelector('.bins__overlap')?.textContent).toContain('重複する語はありません');
  });

  test('枝の祖先ノードを MeSH RDF 名で表示し、第1階層は ID+名前・以降は名前のみ', async () => {
    const doc = buildDoc();
    const onFetchMeshTrees = jest
      .fn()
      .mockResolvedValue([{ descriptor: 'Surgeons', treeNumbers: ['M01.526.485.810.910'] }]);
    const onFetchMeshLabels = jest.fn().mockResolvedValue(
      new Map([
        ['M01', { treeNumber: 'M01', descriptorUi: 'D009272', label: 'Persons' }],
        ['M01.526', { treeNumber: 'M01.526', descriptorUi: 'D009274', label: 'Occupational Groups' }],
        ['M01.526.485', { treeNumber: 'M01.526.485', descriptorUi: 'D006282', label: 'Health Personnel' }],
        ['M01.526.485.810', { treeNumber: 'M01.526.485.810', descriptorUi: 'D010820', label: 'Physicians' }],
      ])
    );
    const el = buildBlockInspector(
      doc,
      baseParams({ expression: '"Surgeons"[Mesh]', onFetchMeshTrees, onFetchMeshLabels })
    )!;
    await flushAsync();
    // ルート文字と起点を除く全祖先でバッチ逆引き（M01 も含む）
    const requested = onFetchMeshLabels.mock.calls[0]![0] as string[];
    expect(requested).toEqual(['M01', 'M01.526', 'M01.526.485', 'M01.526.485.810']);
    // 名前が出る
    const names = Array.from(el.querySelectorAll('.bins__row-name')).map((n) => n.textContent);
    expect(names).toContain('Occupational Groups');
    expect(names).toContain('Health Personnel');
    // 第1階層 M01 は ID を前置（`M01` の row-id がある）
    const ids = Array.from(el.querySelectorAll('.bins__row-id')).map((n) => n.textContent);
    expect(ids).toContain('M01');
    // 第2階層以降は row-id を出さない（Occupational Groups の行に ID span が無い）
    const occRow = Array.from(el.querySelectorAll('.bins__row')).find(
      (r) => r.querySelector('.bins__row-name')?.textContent === 'Occupational Groups'
    )!;
    expect(occRow.querySelector('.bins__row-id')).toBeNull();
  });

  test('起点配下の子を ▸ で遅延展開し、名前クリックで置換、OR追加で OR される', async () => {
    const doc = buildDoc();
    const onFetchMeshTrees = jest
      .fn()
      .mockResolvedValue([{ descriptor: 'Surgeons', treeNumbers: ['M01.526.485.810.910'] }]);
    const onFetchMeshChildren = jest.fn((tn: string) => {
      if (tn === 'M01.526.485.810.910') {
        return Promise.resolve([
          { treeNumber: 'M01.526.485.810.910.750', descriptorUi: 'D000069471', label: 'Neurosurgeons', hasChildren: false },
          { treeNumber: 'M01.526.485.810.910.875', descriptorUi: 'D000072161', label: 'Orthopedic Surgeons', hasChildren: false },
        ]);
      }
      return Promise.resolve([]);
    });
    const onCountHits = jest.fn().mockResolvedValue(5000);
    const onApplyExpression = jest.fn();
    const el = buildBlockInspector(
      doc,
      baseParams({
        expression: '("Surgeons"[Mesh] OR surgeon*[tiab])',
        onFetchMeshTrees,
        onFetchMeshChildren,
        onCountHits,
        onApplyExpression,
      })
    )!;
    await flushAsync();
    // 初期表示では子は取りに行かない（枝だけ）。起点に ▸ が出る。
    expect(onFetchMeshChildren).not.toHaveBeenCalled();
    const originRow = el.querySelector('.bins__row--origin')!;
    originRow.querySelector<HTMLButtonElement>('.bins__row-toggle')!.click();
    await flushAsync();
    // ▸ クリックで起点 Surgeons の子を取得して展開する。
    expect(onFetchMeshChildren).toHaveBeenCalledWith('M01.526.485.810.910');
    const rows = Array.from(el.querySelectorAll('.bins__row'));
    const neuroRow = rows.find((r) => r.querySelector('.bins__row-name')?.textContent === 'Neurosurgeons')!;
    const orthoRow = rows.find((r) => r.querySelector('.bins__row-name')?.textContent === 'Orthopedic Surgeons')!;
    // 名前クリック = 置換（Surgeons → Neurosurgeons、フリーワード保持）
    neuroRow.querySelector<HTMLButtonElement>('.bins__row-name')!.click();
    expect(onApplyExpression).toHaveBeenLastCalledWith('("Neurosurgeons"[Mesh] OR surgeon*[tiab])');
    // OR追加 = 別 OR 項
    orthoRow.querySelector<HTMLButtonElement>('.bins__row-or')!.click();
    expect(onApplyExpression).toHaveBeenLastCalledWith(
      '("Surgeons"[Mesh] OR surgeon*[tiab] OR "Orthopedic Surgeons"[Mesh])'
    );
  });

  test('上位ノードの名前クリックで広げる置換になる', async () => {
    const doc = buildDoc();
    const onFetchMeshTrees = jest
      .fn()
      .mockResolvedValue([{ descriptor: 'Surgeons', treeNumbers: ['M01.526.485.810.910'] }]);
    const onFetchMeshLabels = jest.fn().mockResolvedValue(
      new Map([
        ['M01.526.485.810', { treeNumber: 'M01.526.485.810', descriptorUi: 'D010820', label: 'Physicians' }],
      ])
    );
    const onApplyExpression = jest.fn();
    const el = buildBlockInspector(
      doc,
      baseParams({
        expression: '("Surgeons"[Mesh] OR surgeon*[tiab])',
        onFetchMeshTrees,
        onFetchMeshLabels,
        onCountHits: jest.fn().mockResolvedValue(1),
        onApplyExpression,
      })
    )!;
    await flushAsync();
    const physRow = Array.from(el.querySelectorAll('.bins__row')).find(
      (r) => r.querySelector('.bins__row-name')?.textContent === 'Physicians'
    )!;
    physRow.querySelector<HTMLButtonElement>('.bins__row-name')!.click();
    expect(onApplyExpression).toHaveBeenCalledWith('("Physicians"[Mesh] OR surgeon*[tiab])');
  });

  test('▸ で子を遅延展開し、展開状態を共有 state に保持する', async () => {
    const doc = buildDoc();
    const onFetchMeshTrees = jest
      .fn()
      .mockResolvedValue([{ descriptor: 'Health Personnel', treeNumbers: ['M01.526.485'] }]);
    const onFetchMeshChildren = jest.fn((tn: string) => {
      if (tn === 'M01.526.485') {
        return Promise.resolve([
          { treeNumber: 'M01.526.485.810', descriptorUi: 'D010820', label: 'Physicians', hasChildren: true },
        ]);
      }
      if (tn === 'M01.526.485.810') {
        return Promise.resolve([
          { treeNumber: 'M01.526.485.810.910', descriptorUi: 'D066231', label: 'Surgeons', hasChildren: false },
        ]);
      }
      return Promise.resolve([]);
    });
    const meshExpandedState = new Map<string, Set<string>>();
    const el = buildBlockInspector(
      doc,
      baseParams({
        expression: '"Health Personnel"[Mesh]',
        onFetchMeshTrees,
        onFetchMeshChildren,
        onCountHits: jest.fn().mockResolvedValue(1),
        meshExpandedState,
      })
    )!;
    await flushAsync();
    // 初期表示では起点の子も取りに行かない。起点 ▸ を押して 1 段目（Physicians）を展開する。
    expect(onFetchMeshChildren).not.toHaveBeenCalled();
    el.querySelector('.bins__row--origin')!
      .querySelector<HTMLButtonElement>('.bins__row-toggle')!
      .click();
    await flushAsync();
    expect(onFetchMeshChildren).toHaveBeenCalledWith('M01.526.485');
    // 起点 Health Personnel の子 Physicians（hasChildren=true）に ▸ が出る
    const physRow = Array.from(el.querySelectorAll('.bins__row')).find(
      (r) => r.querySelector('.bins__row-name')?.textContent === 'Physicians'
    )!;
    const toggle = physRow.querySelector<HTMLButtonElement>('.bins__row-toggle')!;
    expect(toggle.textContent).toBe('▸');
    toggle.click();
    await flushAsync();
    expect(onFetchMeshChildren).toHaveBeenCalledWith('M01.526.485.810');
    expect(meshExpandedState.get('1')?.has('M01.526.485.810')).toBe(true);
    // 孫 Surgeons が出る
    const names = Array.from(el.querySelectorAll('.bins__row-name')).map((n) => n.textContent);
    expect(names).toContain('Surgeons');
  });

  test('保持された展開状態は再構築時に子を復元する（起点が展開済みなら ▾）', async () => {
    const doc = buildDoc();
    const onFetchMeshTrees = jest
      .fn()
      .mockResolvedValue([{ descriptor: 'Surgeons', treeNumbers: ['M01.526.485.810.910'] }]);
    const onFetchMeshChildren = jest.fn((tn: string) => {
      if (tn === 'M01.526.485.810.910') {
        return Promise.resolve([
          { treeNumber: 'M01.526.485.810.910.750', descriptorUi: 'D000069471', label: 'Neurosurgeons', hasChildren: false },
        ]);
      }
      return Promise.resolve([]);
    });
    // 起点 tree number を「展開済み」として渡す。
    const meshExpandedState = new Map<string, Set<string>>([['1', new Set(['M01.526.485.810.910'])]]);
    const el = buildBlockInspector(
      doc,
      baseParams({
        expression: '"Surgeons"[Mesh]',
        onFetchMeshTrees,
        onFetchMeshChildren,
        onCountHits: jest.fn().mockResolvedValue(1),
        meshExpandedState,
      })
    )!;
    await flushAsync();
    // クリック無しで子が復元され、起点トグルは ▾。
    expect(onFetchMeshChildren).toHaveBeenCalledWith('M01.526.485.810.910');
    const originRow = el.querySelector('.bins__row--origin')!;
    expect(originRow.querySelector('.bins__row-toggle')?.textContent).toBe('▾');
    const names = Array.from(el.querySelectorAll('.bins__row-name')).map((n) => n.textContent);
    expect(names).toContain('Neurosurgeons');
  });
});
