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
});

describe('buildBlockInspector', () => {
  test('callback が無ければ null を返す', () => {
    const doc = buildDoc();
    const el = buildBlockInspector(doc, baseParams());
    expect(el).toBeNull();
  });

  test('MeSH ツリーを描画し、explode バッジと個別件数を出す', async () => {
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
    // ルート C 疾患 〜 葉 C08.127.108 まで展開される
    const text = el.querySelector('.bins__mesh-body')!.textContent ?? '';
    expect(text).toContain('C 疾患');
    expect(text).toContain('Asthma');
    expect(el.querySelector('.bins__badge--explode')?.textContent).toBe('explode');
    // 個別件数バッジ（"Asthma"[Mesh] で count）
    expect(onCountHits).toHaveBeenCalledWith('"Asthma"[Mesh]');
    expect(el.querySelector('.bins__count--done')?.textContent).toBe('12,300 件');
  });

  test('祖先 explode 用語の子孫に ⚠ 重複バッジを出す', async () => {
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
    const redundant = el.querySelector('.bins__badge--redundant');
    expect(redundant?.textContent).toContain('Lung Diseases配下');
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

  test('祖先ノードに MeSH RDF 逆引きの名前を埋める', async () => {
    const doc = buildDoc();
    const onFetchMeshTrees = jest
      .fn()
      .mockResolvedValue([{ descriptor: 'Surgeons', treeNumbers: ['M01.526.485.810.910'] }]);
    const onFetchMeshLabels = jest.fn().mockResolvedValue(
      new Map([
        ['M01.526.485.810', { treeNumber: 'M01.526.485.810', descriptorUi: 'D010820', label: 'Physicians' }],
        ['M01.526.485', { treeNumber: 'M01.526.485', descriptorUi: 'D006282', label: 'Health Personnel' }],
      ])
    );
    const el = buildBlockInspector(
      doc,
      baseParams({ expression: '"Surgeons"[Mesh]', onFetchMeshTrees, onFetchMeshLabels })
    )!;
    await flushAsync();
    // 祖先 tree number 群でバッチ逆引きが呼ばれる
    expect(onFetchMeshLabels).toHaveBeenCalledTimes(1);
    const requested = onFetchMeshLabels.mock.calls[0]![0] as string[];
    expect(requested).toContain('M01.526.485.810');
    // 名前が span に埋まる
    const names = Array.from(el.querySelectorAll('.bins__tree-name')).map((n) => n.textContent);
    expect(names).toContain('Physicians');
    expect(names).toContain('Health Personnel');
  });

  function openDetails(el: Element): void {
    (el as HTMLDetailsElement).open = true;
    el.dispatchEvent(new Event('toggle'));
  }

  test('下位語ナビ: 開くと子を名前+件数で出し、↓下りるで現在地が変わる', async () => {
    const doc = buildDoc();
    const onFetchMeshTrees = jest
      .fn()
      .mockResolvedValue([{ descriptor: 'Surgeons', treeNumbers: ['M01.526.485.810.910'] }]);
    const onFetchMeshChildren = jest.fn((tn: string) => {
      if (tn === 'M01.526.485.810.910') {
        return Promise.resolve([
          { treeNumber: 'M01.526.485.810.910.750', descriptorUi: 'D000069471', label: 'Neurosurgeons' },
        ]);
      }
      return Promise.resolve([]);
    });
    const onCountHits = jest.fn((q: string) =>
      Promise.resolve(q === '"Surgeons"[Mesh]' ? 21296 : q === '"Neurosurgeons"[Mesh]' ? 5000 : 0)
    );
    const el = buildBlockInspector(
      doc,
      baseParams({ expression: '"Surgeons"[Mesh]', onFetchMeshTrees, onFetchMeshChildren, onCountHits })
    )!;
    await flushAsync();
    const nav = el.querySelector('.bins__nav')!;
    expect(nav.querySelector('.bins__nav-summary')?.textContent).toContain('Surgeons');
    openDetails(nav);
    await flushAsync();
    expect(onFetchMeshChildren).toHaveBeenCalledWith('M01.526.485.810.910');
    // 現在地と子の件数が出る
    expect(nav.querySelector('.bins__nav-here')?.textContent).toContain('Surgeons');
    const child = nav.querySelector('.bins__nav-child')!;
    expect(child.querySelector('.bins__nav-child-label')?.textContent).toBe('Neurosurgeons');
    // ↓下りる → 現在地が Neurosurgeons になり、その子を取りに行く
    child.querySelector<HTMLButtonElement>('.bins__nav-down')!.click();
    await flushAsync();
    expect(onFetchMeshChildren).toHaveBeenCalledWith('M01.526.485.810.910.750');
    expect(nav.querySelector('.bins__nav-here')?.textContent).toContain('Neurosurgeons');
  });

  test('＋追加 で onApplyExpression が新しい式で呼ばれる', async () => {
    const doc = buildDoc();
    const onFetchMeshTrees = jest
      .fn()
      .mockResolvedValue([{ descriptor: 'Surgeons', treeNumbers: ['M01.526.485.810.910'] }]);
    const onFetchMeshChildren = jest
      .fn()
      .mockResolvedValue([
        { treeNumber: 'M01.526.485.810.910.750', descriptorUi: 'D000069471', label: 'Neurosurgeons' },
      ]);
    const onApplyExpression = jest.fn();
    const el = buildBlockInspector(
      doc,
      baseParams({
        expression: '"Surgeons"[Mesh]',
        onFetchMeshTrees,
        onFetchMeshChildren,
        onCountHits: jest.fn().mockResolvedValue(1),
        onApplyExpression,
      })
    )!;
    await flushAsync();
    const nav = el.querySelector('.bins__nav')!;
    openDetails(nav);
    await flushAsync();
    const child = nav.querySelector('.bins__nav-child')!;
    child.querySelector<HTMLButtonElement>('.bins__nav-add')!.click();
    expect(onApplyExpression).toHaveBeenCalledWith('"Surgeons"[Mesh] OR "Neurosurgeons"[Mesh]');
  });

  test('現在地が既存語なら −削除 で onApplyExpression が呼ばれる', async () => {
    const doc = buildDoc();
    const onFetchMeshTrees = jest
      .fn()
      .mockResolvedValue([{ descriptor: 'Surgeons', treeNumbers: ['M01.526.485.810.910'] }]);
    const onFetchMeshChildren = jest.fn().mockResolvedValue([]);
    const onApplyExpression = jest.fn();
    const el = buildBlockInspector(
      doc,
      baseParams({
        expression: '"Surgeons"[Mesh] OR surgeon*[tiab]',
        onFetchMeshTrees,
        onFetchMeshChildren,
        onCountHits: jest.fn().mockResolvedValue(1),
        onApplyExpression,
      })
    )!;
    await flushAsync();
    const nav = el.querySelector('.bins__nav')!;
    openDetails(nav);
    await flushAsync();
    const removeBtn = nav.querySelector<HTMLButtonElement>('.bins__nav-current .bins__nav-remove')!;
    expect(removeBtn.textContent).toContain('削除');
    removeBtn.click();
    expect(onApplyExpression).toHaveBeenCalledWith('surgeon*[tiab]');
  });
});
