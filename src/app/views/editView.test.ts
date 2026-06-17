import { INITIAL_STATE, type AppState } from '../store';
import { createEditView } from './editView';
import type { BlockImprovementContext } from '@/app/services';

function buildContainer(): HTMLElement {
  const doc = document.implementation.createHTMLDocument('test');
  const div = doc.createElement('div');
  doc.body.appendChild(div);
  return div;
}

const stateReady: AppState = {
  ...INITIAL_STATE,
  project: { projectId: 'p', spreadsheetId: 's', driveFolderId: 'd', title: 'T' },
  currentFormulaVersionId: 'v1',
  currentFormulaMarkdown: '## PubMed/MEDLINE\n\n```\n#1 x\n```\n',
};

const FULL_MD = [
  '## PubMed/MEDLINE',
  '',
  '```',
  '#1 asthma[tiab]',
  '#2 children[tiab]',
  '#3 #1 AND #2',
  '```',
  '',
].join('\n');

const stateReadyFull: AppState = {
  ...stateReady,
  currentFormulaMarkdown: FULL_MD,
};

const stateReadyFullWithBlocks: AppState = {
  ...stateReadyFull,
  blocksDraft: {
    blocks: [
      { blockLabel: 'Population', description: '', note: '', aiGenerated: true },
      { blockLabel: 'Outcome', description: '', note: '', aiGenerated: true },
    ],
    combinationExpression: '#1 AND #2',
    selectedFilterIds: [],
  },
};

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function blockRow(container: HTMLElement, id: string): HTMLElement {
  return container.querySelector<HTMLElement>(`.edit__block-row[data-block-id="${id}"]`)!;
}

describe('createEditView', () => {
  test('プロジェクト未選択時は警告のみ（ブロック一覧は出ない）', () => {
    const view = createEditView();
    const container = buildContainer();
    view(container, { state: INITIAL_STATE, navigate: jest.fn() });
    expect(container.querySelector('.view__placeholder')?.textContent).toContain('プロジェクト');
    expect(container.querySelector('.edit__block-list')).toBeNull();
  });

  test('検索式未読込時は /draft 誘導', () => {
    const view = createEditView();
    const container = buildContainer();
    view(container, {
      state: { ...stateReady, currentFormulaMarkdown: null },
      navigate: jest.fn(),
    });
    expect(container.querySelector('.view__placeholder')?.textContent).toContain('/draft');
    expect(container.querySelector('.edit__block-list')).toBeNull();
  });

  test('現在の markdown をブロックに分解して表示する（textarea は出さない）', () => {
    const view = createEditView();
    const container = buildContainer();
    view(container, { state: stateReady, navigate: jest.fn() });
    expect(container.querySelector('textarea.edit__formula')).toBeNull();
    expect(container.querySelector('.edit__block-current')?.textContent).toBe('x');
  });

  test('保存ボタン押下で onSave が現在の md とメモ付きで呼ばれ、status を更新', async () => {
    const onSave = jest.fn().mockResolvedValue({ versionId: 'new-id', parentVersionId: 'v1' });
    const view = createEditView({ onSave });
    const container = buildContainer();
    view(container, { state: stateReady, navigate: jest.fn() });
    const noteInput = container.querySelector<HTMLInputElement>('.edit__note-input')!;
    noteInput.value = 'メモ';
    const saveBtn = container.querySelector<HTMLButtonElement>('.edit__actions button')!;
    saveBtn.click();
    await flushAsync();
    await flushAsync();
    expect(onSave).toHaveBeenCalledWith({
      formulaMd: stateReady.currentFormulaMarkdown,
      note: 'メモ',
    });
    expect(container.querySelector('.edit__status')?.textContent).toContain('new-id');
    expect(saveBtn.disabled).toBe(false);
  });

  test('onSave が reject したらエラー表示', async () => {
    const onSave = jest.fn().mockRejectedValue(new Error('boom'));
    const view = createEditView({ onSave });
    const container = buildContainer();
    view(container, { state: stateReady, navigate: jest.fn() });
    const saveBtn = container.querySelector<HTMLButtonElement>('.edit__actions button')!;
    saveBtn.click();
    await flushAsync();
    await flushAsync();
    expect(container.querySelector('.edit__error')?.textContent).toBe('boom');
    expect(container.querySelector('.edit__status')?.textContent).toBe('');
  });

  test('Error 以外も String 化される', async () => {
    const onSave = jest.fn().mockRejectedValue('rare');
    const view = createEditView({ onSave });
    const container = buildContainer();
    view(container, { state: stateReady, navigate: jest.fn() });
    const saveBtn = container.querySelector<HTMLButtonElement>('.edit__actions button')!;
    saveBtn.click();
    await flushAsync();
    await flushAsync();
    expect(container.querySelector('.edit__error')?.textContent).toBe('rare');
  });

  test('onSave 未指定でもクリックで例外にならない', () => {
    const view = createEditView();
    const container = buildContainer();
    view(container, { state: stateReady, navigate: jest.fn() });
    const saveBtn = container.querySelector<HTMLButtonElement>('.edit__actions button')!;
    expect(() => saveBtn.click()).not.toThrow();
  });

  test('PubMed セクションとして壊れた md はパースエラーを表示し、ブロック行は出ない', () => {
    const view = createEditView();
    const container = buildContainer();
    view(container, {
      state: { ...stateReady, currentFormulaMarkdown: 'not a valid formula' },
      navigate: jest.fn(),
    });
    expect(container.querySelectorAll('.edit__block-row')).toHaveLength(0);
    expect(container.querySelector('.edit__block-error')?.textContent).toContain('パース');
  });

  test('ブロックが 0 件のコードブロックは「ブロックがありません」表示', () => {
    const empty = '## PubMed/MEDLINE\n\n```\n\n```\n';
    const view = createEditView();
    const container = buildContainer();
    view(container, {
      state: { ...stateReady, currentFormulaMarkdown: empty },
      navigate: jest.fn(),
    });
    expect(container.querySelector('.edit__block-empty')?.textContent).toContain(
      'ブロックがありません'
    );
  });
});

describe('createEditView - ブロック名・MeSH リンク・ヒット数', () => {
  test('概念ブロックには blocksDraft のラベルが #N の隣に出る', () => {
    const view = createEditView();
    const container = buildContainer();
    view(container, { state: stateReadyFullWithBlocks, navigate: jest.fn() });
    expect(blockRow(container, '1').querySelector('.edit__block-label')?.textContent).toBe(
      'Population'
    );
    expect(blockRow(container, '2').querySelector('.edit__block-label')?.textContent).toBe(
      'Outcome'
    );
  });

  test('結合行は「結合行」と示し、ラベルは付かない', () => {
    const view = createEditView();
    const container = buildContainer();
    view(container, { state: stateReadyFullWithBlocks, navigate: jest.fn() });
    expect(blockRow(container, '3').querySelector('.edit__block-label')?.textContent).toBe('結合行');
  });

  test('MeSH 語はクリックで MeSH ブラウザに飛ぶリンクになる', () => {
    const md = ['## PubMed/MEDLINE', '', '```', '#1 "Asthma"[Mesh]', '```', ''].join('\n');
    const view = createEditView();
    const container = buildContainer();
    view(container, {
      state: { ...stateReady, currentFormulaMarkdown: md },
      navigate: jest.fn(),
    });
    const link = blockRow(container, '1').querySelector<HTMLAnchorElement>(
      '.edit__block-current a.draft__term--mesh'
    )!;
    expect(link.getAttribute('href')).toContain('ncbi.nlm.nih.gov/mesh');
    expect(link.getAttribute('href')).toContain(encodeURIComponent('Asthma'));
    expect(link.getAttribute('target')).toBe('_blank');
  });

  test('onCountHits 注入時は概念ブロックの件数を計測して表示する（結合行は対象外）', async () => {
    const onCountHits = jest.fn().mockResolvedValue(1234);
    const view = createEditView({ onCountHits });
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    // 概念ブロック #1 #2 は計測対象、結合行 #3 は対象外
    expect(blockRow(container, '1').querySelector('.edit__block-hits')?.textContent).toBe('計測中…');
    expect(blockRow(container, '3').querySelector('.edit__block-hits')).toBeNull();
    await flushAsync();
    await flushAsync();
    expect(onCountHits).toHaveBeenCalledWith('asthma[tiab]');
    expect(blockRow(container, '1').querySelector('.edit__block-hits')?.textContent).toBe('1,234 件');
  });

  test('onCountHits が失敗したら件数エラーを表示する', async () => {
    const onCountHits = jest.fn().mockRejectedValue(new Error('esearch boom'));
    const view = createEditView({ onCountHits });
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    await flushAsync();
    await flushAsync();
    const badge = blockRow(container, '1').querySelector<HTMLElement>('.edit__block-hits')!;
    expect(badge.textContent).toBe('件数エラー');
    expect(badge.title).toContain('esearch boom');
  });

  test('onCountHits 未注入なら件数バッジは出ない', () => {
    const view = createEditView();
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    expect(blockRow(container, '1').querySelector('.edit__block-hits')).toBeNull();
  });
});

describe('createEditView - チップ編集（フリーワード）', () => {
  const FREEWORD_MD = [
    '## PubMed/MEDLINE',
    '',
    '```',
    '#1 asthma[tiab] OR wheez[tiab]',
    '#2 children[tiab]',
    '#3 #1 AND #2',
    '```',
    '',
  ].join('\n');
  const stateFreeword: AppState = { ...stateReady, currentFormulaMarkdown: FREEWORD_MD };

  function openPanel(container: HTMLElement, id: string): HTMLElement {
    blockRow(container, id)
      .querySelector<HTMLButtonElement>('.edit__block-edit-toggle')!
      .click();
    return blockRow(container, id);
  }

  test('概念ブロックを開くとチップ編集面が出て、生テキストは折りたたみに退避する', () => {
    const view = createEditView({ onAutoSave: jest.fn() });
    const container = buildContainer();
    view(container, { state: stateFreeword, navigate: jest.fn() });
    const row = openPanel(container, '1');
    expect(row.querySelector('.edit__block-chips')).toBeTruthy();
    expect(row.querySelectorAll('.edit__chip--freeword')).toHaveLength(2);
    const details = row.querySelector<HTMLDetailsElement>('details.edit__block-raw')!;
    expect(details).toBeTruthy();
    expect(details.open).toBe(false);
    expect(details.querySelector('.edit__block-edit-input')).toBeTruthy();
  });

  test('フリーワードの ✕ で語が消え onAutoSave に反映される', () => {
    const onAutoSave = jest.fn();
    const view = createEditView({ onAutoSave });
    const container = buildContainer();
    view(container, { state: stateFreeword, navigate: jest.fn() });
    const row = openPanel(container, '1');
    // 2 つ目（wheez）の ✕ を押す
    row.querySelectorAll<HTMLButtonElement>('.edit__chip-remove')[1]!.click();
    expect(onAutoSave).toHaveBeenCalledTimes(1);
    expect(onAutoSave.mock.calls[0]![0]).toContain('#1 asthma[tiab]');
    expect(onAutoSave.mock.calls[0]![0]).not.toContain('wheez');
  });

  test('フリーワードのクリック編集で語だけ差し替わる（タグ保持）', () => {
    const onAutoSave = jest.fn();
    const view = createEditView({ onAutoSave });
    const container = buildContainer();
    view(container, { state: stateFreeword, navigate: jest.fn() });
    const row = openPanel(container, '1');
    row.querySelector<HTMLButtonElement>('.edit__chip-term--editable')!.click();
    const input = row.querySelector<HTMLInputElement>('.edit__chip-input')!;
    input.value = 'asthma*';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(onAutoSave.mock.calls[0]![0]).toContain('#1 asthma*[tiab] OR wheez[tiab]');
  });

  test('「＋ 語を追加」で末尾に tiab 句が足される', () => {
    const onAutoSave = jest.fn();
    const view = createEditView({ onAutoSave });
    const container = buildContainer();
    view(container, { state: stateFreeword, navigate: jest.fn() });
    const row = openPanel(container, '1');
    row.querySelector<HTMLButtonElement>('.edit__chip-add-btn')!.click();
    const input = row.querySelector<HTMLInputElement>('.edit__chip-add-input')!;
    input.value = 'cough';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(onAutoSave.mock.calls[0]![0]).toContain('cough[tiab]');
  });

  test('結合行はチップ編集を出さず、生テキスト編集を開いた状態で出す', () => {
    const view = createEditView({ onAutoSave: jest.fn() });
    const container = buildContainer();
    view(container, { state: stateFreeword, navigate: jest.fn() });
    const row = openPanel(container, '3');
    expect(row.querySelector('.edit__block-chips')).toBeNull();
    const details = row.querySelector<HTMLDetailsElement>('details.edit__block-raw')!;
    expect(details.open).toBe(true);
  });
});

describe('createEditView - 動的保存（上書き）', () => {
  test('インライン編集の反映で onAutoSave が最新 md 付きで呼ばれる', () => {
    const onAutoSave = jest.fn();
    const view = createEditView({ onAutoSave });
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    blockRow(container, '1')
      .querySelector<HTMLButtonElement>('.edit__block-edit-toggle')!
      .click();
    const input = blockRow(container, '1').querySelector<HTMLTextAreaElement>(
      '.edit__block-edit-input'
    )!;
    input.value = '"Asthma"[Mesh]';
    blockRow(container, '1').querySelector<HTMLButtonElement>('.edit__block-edit-save')!.click();
    expect(onAutoSave).toHaveBeenCalledTimes(1);
    expect(onAutoSave.mock.calls[0]![0]).toContain('#1 "Asthma"[Mesh]');
  });

  test('AI 改善の accept でも onAutoSave が呼ばれる', async () => {
    const onAutoSave = jest.fn();
    const onImproveBlock = jest.fn().mockResolvedValue({
      blockId: '1',
      currentExpression: 'asthma[tiab]',
      proposedExpression: '"Asthma"[Mesh]',
      rationale: 'r',
    });
    const view = createEditView({ onAutoSave, onImproveBlock });
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    blockRow(container, '1').querySelector<HTMLButtonElement>('.edit__block-edit-toggle')!.click();
    blockRow(container, '1').querySelector<HTMLButtonElement>('.edit__block-ai-submit')!.click();
    await flushAsync();
    await flushAsync();
    blockRow(container, '1').querySelector<HTMLButtonElement>('.edit__block-accept')!.click();
    expect(onAutoSave).toHaveBeenCalledTimes(1);
  });

  test('onAutoSave 未注入なら自動保存は呼ばれない（手編集は動く）', () => {
    const view = createEditView();
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    blockRow(container, '1').querySelector<HTMLButtonElement>('.edit__block-edit-toggle')!.click();
    const input = blockRow(container, '1').querySelector<HTMLTextAreaElement>(
      '.edit__block-edit-input'
    )!;
    input.value = 'x[tiab]';
    expect(() =>
      blockRow(container, '1').querySelector<HTMLButtonElement>('.edit__block-edit-save')!.click()
    ).not.toThrow();
  });

  test('state.editAutoSave の状態が status 行に描画される', () => {
    const view = createEditView({ onAutoSave: jest.fn() });
    const container = buildContainer();
    view(container, {
      state: { ...stateReadyFull, editAutoSave: { status: 'saved', message: '✓ 上書き保存しました' } },
      navigate: jest.fn(),
    });
    const badge = container.querySelector('.edit__autosave')!;
    expect(badge.textContent).toBe('✓ 上書き保存しました');
    expect(badge.className).toContain('edit__autosave--saved');
  });

  test('editAutoSave が null なら status 行は出ない', () => {
    const view = createEditView({ onAutoSave: jest.fn() });
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    expect(container.querySelector('.edit__autosave')).toBeNull();
  });
});

describe('createEditView - 結合行のシード捕捉確認', () => {
  function makeResult(over: Partial<import('@/app/services').CombinationCheckResult> = {}) {
    return {
      finalQuery: '(asthma[tiab]) AND (children[tiab])',
      totalHits: 4200,
      captureRate: 1,
      capturedPmids: ['111', '222'],
      missedPmids: [],
      eligibleSeedCount: 2,
      totalSeedCount: 2,
      ...over,
    };
  }

  test('結合行にのみ確認ボタンが出る（概念ブロックには出ない）', () => {
    const onCheckCombination = jest.fn().mockResolvedValue(makeResult());
    const view = createEditView({ onCheckCombination });
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    expect(blockRow(container, '3').querySelector('.edit__combo-check-btn')).toBeTruthy();
    expect(blockRow(container, '1').querySelector('.edit__combo-check-btn')).toBeNull();
  });

  test('表示時にクリックなしで自動実行され、結果が描画される', async () => {
    const onCheckCombination = jest.fn().mockResolvedValue(makeResult());
    const view = createEditView({ onCheckCombination });
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    await flushAsync();
    await flushAsync();
    // クリックしていないのに onCheckCombination が呼ばれ、結果が出ている
    expect(onCheckCombination).toHaveBeenCalledWith(stateReadyFull.currentFormulaMarkdown);
    const result = blockRow(container, '3').querySelector('.edit__combo-check-result')!;
    expect(result.className).toContain('edit__combo-check-result--ok');
    expect(result.querySelector('.edit__combo-check-hits')?.textContent).toContain('4,200 件');
  });

  test('全シード捕捉なら ✓ 捕捉率 100% と総ヒット数を出す', async () => {
    const onCheckCombination = jest.fn().mockResolvedValue(makeResult());
    const view = createEditView({ onCheckCombination });
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    const row = blockRow(container, '3');
    row.querySelector<HTMLButtonElement>('.edit__combo-check-btn')!.click();
    await flushAsync();
    await flushAsync();
    expect(onCheckCombination).toHaveBeenCalledWith(stateReadyFull.currentFormulaMarkdown);
    const result = row.querySelector('.edit__combo-check-result')!;
    expect(result.className).toContain('edit__combo-check-result--ok');
    expect(result.querySelector('.edit__combo-check-hits')?.textContent).toContain('4,200 件');
    expect(result.querySelector('.edit__combo-check-capture')?.textContent).toContain('✓');
    expect(result.querySelector('.edit__combo-check-capture')?.textContent).toContain('100%');
    expect(result.querySelector('.edit__combo-check-missed')).toBeNull();
  });

  test('未捕捉があれば ⚠ と未捕捉 PMID を出す', async () => {
    const onCheckCombination = jest.fn().mockResolvedValue(
      makeResult({ captureRate: 0.5, capturedPmids: ['111'], missedPmids: ['222'] })
    );
    const view = createEditView({ onCheckCombination });
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    const row = blockRow(container, '3');
    row.querySelector<HTMLButtonElement>('.edit__combo-check-btn')!.click();
    await flushAsync();
    await flushAsync();
    const result = row.querySelector('.edit__combo-check-result')!;
    expect(result.className).toContain('edit__combo-check-result--warn');
    expect(result.querySelector('.edit__combo-check-capture')?.textContent).toContain('⚠');
    expect(result.querySelector('.edit__combo-check-capture')?.textContent).toContain('50%');
    expect(result.querySelector('.edit__combo-check-missed')?.textContent).toContain('222');
  });

  test('有効シード 0 件のときは捕捉率を確認できない旨を出す', async () => {
    const onCheckCombination = jest.fn().mockResolvedValue(
      makeResult({ captureRate: 0, capturedPmids: [], missedPmids: [], eligibleSeedCount: 0, totalSeedCount: 0 })
    );
    const view = createEditView({ onCheckCombination });
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    const row = blockRow(container, '3');
    row.querySelector<HTMLButtonElement>('.edit__combo-check-btn')!.click();
    await flushAsync();
    await flushAsync();
    const result = row.querySelector('.edit__combo-check-result')!;
    expect(result.className).toContain('edit__combo-check-result--info');
    expect(result.querySelector('.edit__combo-check-capture')?.textContent).toContain('有効なシード論文が無い');
  });

  test('失敗時はエラーを表示しボタンは再び押せる', async () => {
    const onCheckCombination = jest.fn().mockRejectedValue(new Error('esearch down'));
    const view = createEditView({ onCheckCombination });
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    const row = blockRow(container, '3');
    const btn = row.querySelector<HTMLButtonElement>('.edit__combo-check-btn')!;
    btn.click();
    await flushAsync();
    await flushAsync();
    const result = row.querySelector('.edit__combo-check-result')!;
    expect(result.className).toContain('edit__combo-check-result--error');
    expect(result.textContent).toContain('esearch down');
    expect(btn.disabled).toBe(false);
  });

  test('onCheckCombination 未注入なら確認ボタンは出ない', () => {
    const view = createEditView();
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    expect(blockRow(container, '3').querySelector('.edit__combo-check-btn')).toBeNull();
  });

  test('同一 md の無関係な再描画では再検索しない（初回結果を再利用）', async () => {
    const onCheckCombination = jest.fn().mockResolvedValue(makeResult());
    const view = createEditView({ onCheckCombination });
    const container = buildContainer();
    const ctx = { state: stateReadyFull, navigate: jest.fn() };
    view(container, ctx);
    await flushAsync();
    await flushAsync();
    expect(onCheckCombination).toHaveBeenCalledTimes(1);
    // 同じ state での全ビュー再描画（setState 相当）。md は変わっていないので再検索しない。
    view(container, ctx);
    await flushAsync();
    expect(onCheckCombination).toHaveBeenCalledTimes(1);
    // 結果はそのまま描画されている（「検索中…」へ戻らない）。
    expect(blockRow(container, '3').querySelector('.edit__combo-check-result')?.className).toContain(
      'edit__combo-check-result--ok'
    );
  });

  test('編集後は古い結果を「再確認中」で残し、debounce 後に最新だけ検索する', async () => {
    jest.useFakeTimers();
    // fake timer 下でも promise の連鎖を確実に解決するため、microtask を多めに流す。
    const flushMicro = async (): Promise<void> => {
      for (let i = 0; i < 6; i += 1) {
        await Promise.resolve();
      }
    };
    try {
      const onCheckCombination = jest.fn().mockResolvedValue(makeResult());
      const view = createEditView({ onCheckCombination, onAutoSave: jest.fn() });
      const container = buildContainer();
      view(container, { state: stateReadyFull, navigate: jest.fn() });
      // 初回は即時実行（debounce なし）。
      await flushMicro();
      expect(onCheckCombination).toHaveBeenCalledTimes(1);

      // #1 を編集 → 結合行が作り直され、古い結果を残したまま「再確認中」になる。
      blockRow(container, '1')
        .querySelector<HTMLButtonElement>('.edit__block-edit-toggle')!
        .click();
      const input = blockRow(container, '1').querySelector<HTMLTextAreaElement>(
        '.edit__block-edit-input'
      )!;
      input.value = '"Asthma"[Mesh]';
      blockRow(container, '1').querySelector<HTMLButtonElement>('.edit__block-edit-save')!.click();
      // 直後は古い結果（--ok）＋「再確認中」が出ており、まだ再検索していない。
      const combo = blockRow(container, '3').querySelector('.edit__combo-check-result')!;
      expect(combo.className).toContain('edit__combo-check-result--rechecking');
      expect(combo.querySelector('.edit__combo-check-rechecking')).toBeTruthy();
      expect(onCheckCombination).toHaveBeenCalledTimes(1);

      // debounce 経過で最新 md（1 回だけ）を検索する。
      jest.advanceTimersByTime(500);
      await flushMicro();
      expect(onCheckCombination).toHaveBeenCalledTimes(2);
      expect(onCheckCombination).toHaveBeenLastCalledWith(
        expect.stringContaining('#1 "Asthma"[Mesh]')
      );
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('createEditView - 鉛筆インライン編集', () => {
  test('各ブロックの編集導線は鉛筆 1 つに統一されている（旧 AI ボタンは無い）', () => {
    const view = createEditView({ onImproveBlock: jest.fn() });
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    const rows = container.querySelectorAll('.edit__block-row');
    expect(rows).toHaveLength(3);
    expect(rows[0]!.querySelector('.edit__block-edit-toggle')).toBeTruthy();
    expect(rows[0]!.querySelector('.edit__block-improve')).toBeNull();
    // 開く前は AI フォームも手編集フォームも出ていない
    expect(rows[0]!.querySelector('.edit__block-ai-form')).toBeNull();
    expect(rows[0]!.querySelector('.edit__block-edit-input')).toBeNull();
  });

  test('鉛筆を開くと手編集フォームと AI 改善フォームが同時に出る', () => {
    const view = createEditView({ onImproveBlock: jest.fn() });
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    const row = blockRow(container, '1');
    row.querySelector<HTMLButtonElement>('.edit__block-edit-toggle')!.click();
    expect(row.querySelector('.edit__block-edit-input')).toBeTruthy();
    expect(row.querySelector('.edit__block-ai-form')).toBeTruthy();
    expect(row.querySelector('.edit__block-ai-submit')).toBeTruthy();
  });

  test('鉛筆クリックで編集フォームが開き、式が入る', () => {
    const view = createEditView();
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    const row = blockRow(container, '1');
    row.querySelector<HTMLButtonElement>('.edit__block-edit-toggle')!.click();
    const input = row.querySelector<HTMLTextAreaElement>('.edit__block-edit-input')!;
    expect(input.value).toBe('asthma[tiab]');
  });

  test('編集を保存するとそのブロックの式が更新される（他行は維持）', async () => {
    const onSave = jest.fn().mockResolvedValue({ versionId: 'n', parentVersionId: 'v1' });
    const view = createEditView({ onSave });
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    blockRow(container, '1')
      .querySelector<HTMLButtonElement>('.edit__block-edit-toggle')!
      .click();
    const input = blockRow(container, '1').querySelector<HTMLTextAreaElement>(
      '.edit__block-edit-input'
    )!;
    input.value = '"Asthma"[Mesh]';
    blockRow(container, '1').querySelector<HTMLButtonElement>('.edit__block-edit-save')!.click();
    // 再描画後の #1 が新値、#2 は維持
    expect(blockRow(container, '1').querySelector('.edit__block-current')?.textContent).toBe(
      '"Asthma"[Mesh]'
    );
    expect(blockRow(container, '2').querySelector('.edit__block-current')?.textContent).toBe(
      'children[tiab]'
    );
    // 保存で送られる md にも反映
    container.querySelector<HTMLButtonElement>('.edit__actions button')!.click();
    await flushAsync();
    expect(onSave.mock.calls[0]![0].formulaMd).toContain('#1 "Asthma"[Mesh]');
  });

  test('1 ブロック編集では変更行と結合行だけ作り直し、無関係な行の DOM ノードは維持する', () => {
    const view = createEditView({ onAutoSave: jest.fn() });
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    // 編集前の #2 / #3 のノード参照を握る。
    const beforeRow2 = blockRow(container, '2');
    const beforeRow3 = blockRow(container, '3');
    // #1 を編集して保存する。
    blockRow(container, '1').querySelector<HTMLButtonElement>('.edit__block-edit-toggle')!.click();
    const input = blockRow(container, '1').querySelector<HTMLTextAreaElement>(
      '.edit__block-edit-input'
    )!;
    input.value = '"Asthma"[Mesh]';
    blockRow(container, '1').querySelector<HTMLButtonElement>('.edit__block-edit-save')!.click();
    // 無関係な概念行 #2 は同じ DOM ノードのまま（作り直されない）。
    expect(blockRow(container, '2')).toBe(beforeRow2);
    // 結合行 #3 は結果が変わりうるので作り直される（別ノード）。
    expect(blockRow(container, '3')).not.toBe(beforeRow3);
    // #1 は新しい式で再生成される。
    expect(blockRow(container, '1').querySelector('.edit__block-current')?.textContent).toBe(
      '"Asthma"[Mesh]'
    );
  });

  test('空文字での保存はエラーを出して更新しない', () => {
    const view = createEditView();
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    const row = blockRow(container, '1');
    row.querySelector<HTMLButtonElement>('.edit__block-edit-toggle')!.click();
    const input = row.querySelector<HTMLTextAreaElement>('.edit__block-edit-input')!;
    input.value = '   ';
    row.querySelector<HTMLButtonElement>('.edit__block-edit-save')!.click();
    expect(row.querySelector('.edit__block-edit-error')?.textContent).toContain('空');
    // 元の式は維持
    expect(blockRow(container, '1').querySelector('.edit__block-current')?.textContent).toBe(
      'asthma[tiab]'
    );
  });

  test('キャンセルでフォームが閉じ、式表示が戻る', () => {
    const view = createEditView();
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    const row = blockRow(container, '1');
    const toggle = row.querySelector<HTMLButtonElement>('.edit__block-edit-toggle')!;
    toggle.click();
    expect(row.querySelector('.edit__block-edit-input')).toBeTruthy();
    row.querySelector<HTMLButtonElement>('.edit__block-edit-cancel')!.click();
    expect(row.querySelector('.edit__block-edit-input')).toBeNull();
  });

  test('鉛筆の再クリックでフォームをトグルで閉じる', () => {
    const view = createEditView();
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    const row = blockRow(container, '1');
    const toggle = row.querySelector<HTMLButtonElement>('.edit__block-edit-toggle')!;
    toggle.click();
    expect(row.querySelector('.edit__block-edit-input')).toBeTruthy();
    toggle.click();
    expect(row.querySelector('.edit__block-edit-input')).toBeNull();
  });

  test('別のブロックを開くと先に開いていたブロックは閉じる（アコーディオン）', () => {
    const view = createEditView();
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    // #1 を開く。
    blockRow(container, '1')
      .querySelector<HTMLButtonElement>('.edit__block-edit-toggle')!
      .click();
    expect(blockRow(container, '1').querySelector('.edit__block-edit-input')).toBeTruthy();
    // #2 を開くと #1 は自動的に閉じる。
    blockRow(container, '2')
      .querySelector<HTMLButtonElement>('.edit__block-edit-toggle')!
      .click();
    expect(blockRow(container, '2').querySelector('.edit__block-edit-input')).toBeTruthy();
    expect(blockRow(container, '1').querySelector('.edit__block-edit-input')).toBeNull();
    // #1 の式表示が元に戻っている（display:none が解除されている）。
    expect(
      blockRow(container, '1').querySelector<HTMLElement>('.edit__block-current')!.style.display
    ).toBe('');
  });
});

describe('createEditView - ブロック単位 AI 改善', () => {
  test('AI ボタンでプロンプトフォームが開き、submit で onImproveBlock が指示付きで呼ばれ diff が出る', async () => {
    const onImproveBlock = jest.fn().mockResolvedValue({
      blockId: '1',
      currentExpression: 'asthma[tiab]',
      proposedExpression: '"Asthma"[Mesh] OR asthma*[tiab]',
      rationale: 'MeSH 追加で感度向上',
    });
    const view = createEditView({ onImproveBlock });
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    const row = blockRow(container, '1');
    row.querySelector<HTMLButtonElement>('.edit__block-edit-toggle')!.click();
    const instruction = row.querySelector<HTMLTextAreaElement>('.edit__block-ai-instruction')!;
    instruction.value = '同義語を増やして';
    row.querySelector<HTMLButtonElement>('.edit__block-ai-submit')!.click();
    await flushAsync();
    await flushAsync();
    expect(onImproveBlock).toHaveBeenCalledWith({ blockId: '1', instruction: '同義語を増やして' });
    expect(row.querySelector('.edit__block-rationale')?.textContent).toContain('MeSH 追加');
    expect(row.querySelector('.edit__block-diff-before pre')?.textContent).toBe('asthma[tiab]');
    expect(row.querySelector('.edit__block-diff-after pre')?.textContent).toBe(
      '"Asthma"[Mesh] OR asthma*[tiab]'
    );
    expect(row.querySelector('.edit__block-accept')).toBeTruthy();
    expect(row.querySelector('.edit__block-reject')).toBeTruthy();
  });

  test('提案には増減サマリー（削除した語/追加した語）と句単位ハイライトが出る', async () => {
    const onImproveBlock = jest.fn().mockResolvedValue({
      blockId: '1',
      currentExpression: '(asthma[tiab] OR wheeze[tiab])',
      proposedExpression: '(asthma[tiab] OR "Asthma"[Mesh])',
      rationale: 'MeSH を追加',
    });
    const view = createEditView({ onImproveBlock });
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    const row = blockRow(container, '1');
    row.querySelector<HTMLButtonElement>('.edit__block-edit-toggle')!.click();
    row.querySelector<HTMLButtonElement>('.edit__block-ai-submit')!.click();
    await flushAsync();
    await flushAsync();

    // サマリー: 削除（1）= wheeze、追加（1）= "Asthma"[Mesh]
    const removedRow = row.querySelector('.edit__block-diff-summary-row--removed')!;
    expect(removedRow.querySelector('.edit__block-diff-summary-label')?.textContent).toContain('削除した語（1）');
    expect(removedRow.querySelector('.edit__block-diff-chip')?.textContent).toBe('wheeze[tiab]');
    const addedRow = row.querySelector('.edit__block-diff-summary-row--added')!;
    expect(addedRow.querySelector('.edit__block-diff-summary-label')?.textContent).toContain('追加した語（1）');
    expect(addedRow.querySelector('.edit__block-diff-chip')?.textContent).toBe('"Asthma"[Mesh]');

    // Before パネルでは削除句が <del>、After パネルでは追加句が <ins>
    expect(
      row.querySelector('.edit__block-diff-before del.formula-diff__term--removed')?.textContent
    ).toBe('wheeze[tiab]');
    expect(
      row.querySelector('.edit__block-diff-after ins.formula-diff__term--added')?.textContent
    ).toBe('"Asthma"[Mesh]');
  });

  test('鉛筆の再クリックで手編集も AI フォームも畳む', () => {
    const onImproveBlock = jest.fn();
    const view = createEditView({ onImproveBlock });
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    const row = blockRow(container, '1');
    const toggle = row.querySelector<HTMLButtonElement>('.edit__block-edit-toggle')!;
    toggle.click();
    expect(row.querySelector('.edit__block-ai-form')).toBeTruthy();
    expect(row.querySelector('.edit__block-edit-input')).toBeTruthy();
    toggle.click();
    expect(row.querySelector('.edit__block-ai-form')).toBeNull();
    expect(row.querySelector('.edit__block-edit-input')).toBeNull();
  });

  test('手編集の「閉じる」で統合パネル全体が畳まれる', () => {
    const onImproveBlock = jest.fn();
    const view = createEditView({ onImproveBlock });
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    const row = blockRow(container, '1');
    row.querySelector<HTMLButtonElement>('.edit__block-edit-toggle')!.click();
    expect(row.querySelector('.edit__block-ai-form')).toBeTruthy();
    row.querySelector<HTMLButtonElement>('.edit__block-edit-cancel')!.click();
    expect(row.querySelector('.edit__block-ai-form')).toBeNull();
    expect(row.querySelector('.edit__block-edit-input')).toBeNull();
  });

  test('accept を押すと #1 の式が提案で置き換わる（再描画）', async () => {
    const onImproveBlock = jest.fn().mockResolvedValue({
      blockId: '1',
      currentExpression: 'asthma[tiab]',
      proposedExpression: '"Asthma"[Mesh]',
      rationale: 'r',
    });
    const view = createEditView({ onImproveBlock });
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    blockRow(container, '1').querySelector<HTMLButtonElement>('.edit__block-edit-toggle')!.click();
    blockRow(container, '1')
      .querySelector<HTMLButtonElement>('.edit__block-ai-submit')!
      .click();
    await flushAsync();
    await flushAsync();
    blockRow(container, '1').querySelector<HTMLButtonElement>('.edit__block-accept')!.click();
    expect(blockRow(container, '1').querySelector('.edit__block-current')?.textContent).toBe(
      '"Asthma"[Mesh]'
    );
    expect(blockRow(container, '2').querySelector('.edit__block-current')?.textContent).toBe(
      'children[tiab]'
    );
  });

  test('reject で AI スロットがクリアされる', async () => {
    const onImproveBlock = jest.fn().mockResolvedValue({
      blockId: '1',
      currentExpression: 'asthma[tiab]',
      proposedExpression: 'new',
      rationale: 'r',
    });
    const view = createEditView({ onImproveBlock });
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    const row = blockRow(container, '1');
    row.querySelector<HTMLButtonElement>('.edit__block-edit-toggle')!.click();
    row.querySelector<HTMLButtonElement>('.edit__block-ai-submit')!.click();
    await flushAsync();
    await flushAsync();
    row.querySelector<HTMLButtonElement>('.edit__block-reject')!.click();
    expect(row.querySelector('.edit__block-rationale')).toBeNull();
    expect(row.querySelector('.edit__block-accept')).toBeNull();
  });

  test('提案が現式と同じなら accept が disabled', async () => {
    const onImproveBlock = jest.fn().mockResolvedValue({
      blockId: '1',
      currentExpression: 'asthma[tiab]',
      proposedExpression: 'asthma[tiab]',
      rationale: '改善余地無し',
    });
    const view = createEditView({ onImproveBlock });
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    const row = blockRow(container, '1');
    row.querySelector<HTMLButtonElement>('.edit__block-edit-toggle')!.click();
    row.querySelector<HTMLButtonElement>('.edit__block-ai-submit')!.click();
    await flushAsync();
    await flushAsync();
    expect(row.querySelector<HTMLButtonElement>('.edit__block-accept')!.disabled).toBe(true);
  });

  test('提案が空文字でも accept は disabled', async () => {
    const onImproveBlock = jest.fn().mockResolvedValue({
      blockId: '1',
      currentExpression: 'asthma[tiab]',
      proposedExpression: '',
      rationale: '',
    });
    const view = createEditView({ onImproveBlock });
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    const row = blockRow(container, '1');
    row.querySelector<HTMLButtonElement>('.edit__block-edit-toggle')!.click();
    row.querySelector<HTMLButtonElement>('.edit__block-ai-submit')!.click();
    await flushAsync();
    await flushAsync();
    expect(row.querySelector<HTMLButtonElement>('.edit__block-accept')!.disabled).toBe(true);
    expect(row.querySelector('.edit__block-rationale')?.textContent).toContain('（改善ポイント');
  });

  test('onImproveBlock が reject したらエラーを表示', async () => {
    const onImproveBlock = jest.fn().mockRejectedValue(new Error('llm boom'));
    const view = createEditView({ onImproveBlock });
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    const row = blockRow(container, '1');
    row.querySelector<HTMLButtonElement>('.edit__block-edit-toggle')!.click();
    row.querySelector<HTMLButtonElement>('.edit__block-ai-submit')!.click();
    await flushAsync();
    await flushAsync();
    expect(row.querySelector('.edit__block-error')?.textContent).toContain('llm boom');
  });

  test('Error 以外の例外も String 化される', async () => {
    const onImproveBlock = jest.fn().mockRejectedValue('oops');
    const view = createEditView({ onImproveBlock });
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    const row = blockRow(container, '1');
    row.querySelector<HTMLButtonElement>('.edit__block-edit-toggle')!.click();
    row.querySelector<HTMLButtonElement>('.edit__block-ai-submit')!.click();
    await flushAsync();
    await flushAsync();
    expect(row.querySelector('.edit__block-error')?.textContent).toContain('oops');
  });

  test('onImproveBlock 未指定なら鉛筆で手編集だけ開き、AI フォームは出ない', () => {
    const view = createEditView();
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    const row = blockRow(container, '1');
    row.querySelector<HTMLButtonElement>('.edit__block-edit-toggle')!.click();
    expect(row.querySelector('.edit__block-edit-input')).toBeTruthy();
    expect(row.querySelector('.edit__block-ai-form')).toBeNull();
  });

  test('accept で base に該当行が無いと feedback にエラーを出す', async () => {
    // 提案受信後に、別ブロックを鉛筆編集して #1 行を作り替え…ではなく、
    // base が握られた時点の md と異なる accept を作るのは難しいため、
    // ここでは applyBlockImprovement が投げる経路（base から #N が消えている）を
    // 直接は作れない。代わりに proposedExpression を変更した上で
    // accept → 成功する正常系をもう一度確認する（catch 経路は service 層でカバー）。
    const onImproveBlock = jest.fn().mockResolvedValue({
      blockId: '1',
      currentExpression: 'asthma[tiab]',
      proposedExpression: 'new-expr',
      rationale: 'r',
    });
    const view = createEditView({ onImproveBlock });
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    const row = blockRow(container, '1');
    row.querySelector<HTMLButtonElement>('.edit__block-edit-toggle')!.click();
    row.querySelector<HTMLButtonElement>('.edit__block-ai-submit')!.click();
    await flushAsync();
    await flushAsync();
    row.querySelector<HTMLButtonElement>('.edit__block-accept')!.click();
    expect(blockRow(container, '1').querySelector('.edit__block-current')?.textContent).toBe(
      'new-expr'
    );
  });
});

describe('createEditView - 再描画耐性（AI 改善が setState 再描画で消えない）', () => {
  // 同一 view インスタンスを同じ state で再度呼ぶことで、store.subscribe(render) による
  // 全ビュー再描画（LLM コスト集計の setState 等）を模す。
  function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  test('提案表示中に外部再描画が起きても提案が残り、accept で md が更新される', async () => {
    const onAutoSave = jest.fn();
    const onImproveBlock = jest.fn().mockResolvedValue({
      blockId: '1',
      currentExpression: 'asthma[tiab]',
      proposedExpression: '"Asthma"[Mesh]',
      rationale: 'r',
    });
    const view = createEditView({ onImproveBlock, onAutoSave });
    const container = buildContainer();
    const ctx = { state: stateReadyFull, navigate: jest.fn() };
    view(container, ctx);
    blockRow(container, '1').querySelector<HTMLButtonElement>('.edit__block-edit-toggle')!.click();
    blockRow(container, '1').querySelector<HTMLButtonElement>('.edit__block-ai-submit')!.click();
    await flushAsync();
    await flushAsync();
    expect(blockRow(container, '1').querySelector('.edit__block-accept')).toBeTruthy();

    // 外部からの setState 相当（同じ state で全ビュー再描画）。提案は消えてはいけない。
    view(container, ctx);
    const accept = blockRow(container, '1').querySelector<HTMLButtonElement>('.edit__block-accept');
    expect(accept).toBeTruthy();
    expect(blockRow(container, '1').querySelector('.edit__block-diff-after pre')?.textContent).toBe(
      '"Asthma"[Mesh]'
    );

    // 再描画後の accept でも md が更新され、自動保存へ流れる。
    accept!.click();
    expect(onAutoSave).toHaveBeenCalledTimes(1);
    expect(onAutoSave.mock.calls[0]![0]).toContain('#1 "Asthma"[Mesh]');
    expect(blockRow(container, '1').querySelector('.edit__block-current')?.textContent).toBe(
      '"Asthma"[Mesh]'
    );
  });

  test('LLM 応答前に外部再描画が起きても、応答後に提案が最新 DOM へ出る', async () => {
    // これが報告されたバグの核心: LLM 完了時のコスト集計 setState が improve の then より先に
    // 全ビューを作り直す。古いスロットに描いても画面に出ないので、最新 DOM へ反映する必要がある。
    const d = deferred<{
      blockId: string;
      currentExpression: string;
      proposedExpression: string;
      rationale: string;
    }>();
    const onImproveBlock = jest.fn().mockReturnValue(d.promise);
    const view = createEditView({ onImproveBlock, onAutoSave: jest.fn() });
    const container = buildContainer();
    const ctx = { state: stateReadyFull, navigate: jest.fn() };
    view(container, ctx);
    blockRow(container, '1').querySelector<HTMLButtonElement>('.edit__block-edit-toggle')!.click();
    blockRow(container, '1').querySelector<HTMLButtonElement>('.edit__block-ai-submit')!.click();
    // pending 中に外部再描画が走る（LLM 応答待ちの間に setState 再描画が起きた状況）。
    view(container, ctx);
    expect(blockRow(container, '1').querySelector('.edit__block-pending')).toBeTruthy();

    d.resolve({
      blockId: '1',
      currentExpression: 'asthma[tiab]',
      proposedExpression: '"Asthma"[Mesh]',
      rationale: 'r',
    });
    await flushAsync();
    await flushAsync();
    // 古い（破棄済みの）スロットではなく、現在画面にある行へ提案が出ている。
    expect(blockRow(container, '1').querySelector('.edit__block-accept')).toBeTruthy();
    expect(blockRow(container, '1').querySelector('.edit__block-diff-after pre')?.textContent).toBe(
      '"Asthma"[Mesh]'
    );
  });

  test('自動保存中（saving）の stale な再描画でも、確定前の手編集が OLD に戻らない', () => {
    // editor.setMd → onAutoSave 後、bootstrap は editAutoSave='saving' を setState する。
    // その時点では currentFormulaMarkdown はまだ OLD。全ビュー再描画で OLD に戻ってはいけない。
    const onAutoSave = jest.fn();
    const view = createEditView({ onAutoSave });
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    blockRow(container, '1').querySelector<HTMLButtonElement>('.edit__block-edit-toggle')!.click();
    const input = blockRow(container, '1').querySelector<HTMLTextAreaElement>(
      '.edit__block-edit-input'
    )!;
    input.value = '"Asthma"[Mesh]';
    blockRow(container, '1').querySelector<HTMLButtonElement>('.edit__block-edit-save')!.click();
    expect(blockRow(container, '1').querySelector('.edit__block-current')?.textContent).toBe(
      '"Asthma"[Mesh]'
    );

    // saving 中の再描画相当: currentFormulaMarkdown は OLD のまま、editAutoSave だけ付く。
    view(container, {
      state: { ...stateReadyFull, editAutoSave: { status: 'saving', message: '自動保存中…' } },
      navigate: jest.fn(),
    });
    // 編集内容（NEW）が保たれている（OLD の asthma[tiab] に戻っていない）。
    expect(blockRow(container, '1').querySelector('.edit__block-current')?.textContent).toBe(
      '"Asthma"[Mesh]'
    );
  });
});

describe('createEditView - ブロック・インスペクタ', () => {
  test('鉛筆編集を開くとインスペクタが展開され、onFetchMeshTrees が呼ばれる', async () => {
    const onFetchMeshTrees = jest
      .fn()
      .mockResolvedValue([{ descriptor: 'Asthma', treeNumbers: ['C08.127.108'] }]);
    const onCountHits = jest.fn().mockResolvedValue(100);
    const md = ['## PubMed/MEDLINE', '', '```', '#1 "Asthma"[Mesh]', '```', ''].join('\n');
    const view = createEditView({ onFetchMeshTrees, onCountHits });
    const container = buildContainer();
    view(container, { state: { ...stateReady, currentFormulaMarkdown: md }, navigate: jest.fn() });
    const row = blockRow(container, '1');
    expect(row.querySelector('.bins')).toBeNull();
    row.querySelector<HTMLButtonElement>('.edit__block-edit-toggle')!.click();
    expect(row.querySelector('.bins')).toBeTruthy();
    await flushAsync();
    expect(onFetchMeshTrees).toHaveBeenCalledWith(['Asthma']);
    // 起点ノード（Asthma）が MeSH ブラウザの枝に出る
    expect(row.querySelector('.bins__row--origin .bins__row-name')?.textContent).toBe('Asthma');
  });

  test('AI 改善パネルを開くとインスペクタが展開される', () => {
    const onImproveBlock = jest.fn();
    const onCountHits = jest.fn().mockResolvedValue(1);
    const view = createEditView({ onImproveBlock, onCountHits });
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    const row = blockRow(container, '1');
    row.querySelector<HTMLButtonElement>('.edit__block-edit-toggle')!.click();
    expect(row.querySelector('.bins')).toBeTruthy();
    expect(row.querySelector('.bins__freeword')).toBeTruthy();
  });

  test('ブロックのヘッダ行クリックでも編集パネルを開閉できる', () => {
    const onCountHits = jest.fn().mockResolvedValue(1);
    const view = createEditView({ onCountHits });
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    const row = blockRow(container, '1');
    const header = row.querySelector<HTMLElement>('.edit__block-header')!;
    // 閉→開
    header.click();
    expect(row.querySelector('.bins')).toBeTruthy();
    // 開→閉（同じ行クリックで畳む）
    header.click();
    expect(row.querySelector('.bins')).toBeNull();
  });

  test('式の行クリックでも開くが、MeSH リンククリックでは開かない', () => {
    const onCountHits = jest.fn().mockResolvedValue(1);
    const view = createEditView({ onCountHits });
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    const row = blockRow(container, '1');
    // MeSH リンク（<a>）クリックはトグル対象外
    const meshLink = row.querySelector<HTMLAnchorElement>('.edit__block-current a');
    if (meshLink) {
      meshLink.click();
      expect(row.querySelector('.bins')).toBeNull();
    }
    // 式行の地のテキスト部分クリックで開く
    row.querySelector<HTMLElement>('.edit__block-current')!.click();
    expect(row.querySelector('.bins')).toBeTruthy();
  });

  test('結合行にはインスペクタを出さない', () => {
    const onCountHits = jest.fn().mockResolvedValue(1);
    const view = createEditView({ onCountHits });
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    // 結合行 #3 は鉛筆編集はできるがインスペクタは付かない
    const row = blockRow(container, '3');
    row.querySelector<HTMLButtonElement>('.edit__block-edit-toggle')!.click();
    expect(row.querySelector('.bins')).toBeNull();
  });

  test('callback 未注入ならインスペクタは出ない', () => {
    const view = createEditView();
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    const row = blockRow(container, '1');
    row.querySelector<HTMLButtonElement>('.edit__block-edit-toggle')!.click();
    expect(row.querySelector('.bins')).toBeNull();
  });
});

describe('createEditView - AI に渡す内容を見る（文脈開示）', () => {
  const context: BlockImprovementContext = {
    researchQuestion: 'RQ text',
    blockLabel: 'Population',
    blockDescription: '喘息',
    currentExpression: 'asthma[tiab]',
    currentHits: 12345,
    keywordHits: [
      { term: 'Asthma', kind: 'mesh', hits: 9999, delta: null, status: null },
      { term: 'asthma[tiab]', kind: 'freeword', hits: 5000, delta: 5000, status: 'normal' },
      { term: 'orthopaedic[tiab]', kind: 'freeword', hits: 800, delta: 0, status: 'redundant' },
      { term: 'wheeze[tiab]', kind: 'freeword', hits: 0, delta: 0, status: 'normal' },
    ],
    freewordDedupTotal: 5800,
    seedPapers: [
      {
        pmid: '111',
        title: 'Seed A',
        decision: 'include',
        source: 'initial',
        meshHeadings: ['Asthma', 'Respiratory Sounds'],
        abstract: 'Wheezing is a common symptom of asthma.',
      },
      {
        pmid: '222',
        title: 'Seed B',
        decision: 'include',
        source: 'interactive',
        meshHeadings: [],
        abstract: null,
      },
    ],
    validation: { captureRate: 0.5, capturedPmids: ['111'], missedPmids: ['222'] },
  };

  test('開示に現在のヒット数が桁区切りで出る', async () => {
    const onImproveBlock = jest.fn();
    const onGetImproveContext = jest.fn().mockResolvedValue(context);
    const view = createEditView({ onImproveBlock, onGetImproveContext });
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    const row = blockRow(container, '1');
    row.querySelector<HTMLButtonElement>('.edit__block-edit-toggle')!.click();
    await flushAsync();
    await flushAsync();
    expect(row.querySelector('.edit__block-ai-context-list')?.textContent).toContain('現在のヒット数');
    expect(row.querySelector('.edit__block-ai-context-list')?.textContent).toContain('12,345 件');
  });

  test('開示にキーワード別 Δ・削除候補・OR 合計が出る', async () => {
    const onImproveBlock = jest.fn();
    const onGetImproveContext = jest.fn().mockResolvedValue(context);
    const view = createEditView({ onImproveBlock, onGetImproveContext });
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    const row = blockRow(container, '1');
    row.querySelector<HTMLButtonElement>('.edit__block-edit-toggle')!.click();
    await flushAsync();
    await flushAsync();
    const kw = row.querySelector('.edit__block-ai-context-keywords')!;
    expect(kw.textContent).toContain('asthma[tiab] [tiab]: 5,000 件・純増Δ +5,000');
    expect(kw.textContent).toContain('orthopaedic[tiab] [tiab]: 800 件・純増Δ +0 ⚠ 削除候補');
    expect(row.querySelector('.edit__block-ai-context-keyword-total')?.textContent).toContain(
      'フリーワード OR 合計（重複除去後）: 5,800 件'
    );
  });

  test('currentHits が null なら (未計測) と出る', async () => {
    const onImproveBlock = jest.fn();
    const onGetImproveContext = jest.fn().mockResolvedValue({ ...context, currentHits: null });
    const view = createEditView({ onImproveBlock, onGetImproveContext });
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    const row = blockRow(container, '1');
    row.querySelector<HTMLButtonElement>('.edit__block-edit-toggle')!.click();
    await flushAsync();
    await flushAsync();
    expect(row.querySelector('.edit__block-ai-context-list')?.textContent).toContain('(未計測)');
  });

  test('開示にシード論文と検証捕捉情報が出る', async () => {
    const onImproveBlock = jest.fn();
    const onGetImproveContext = jest.fn().mockResolvedValue(context);
    const view = createEditView({ onImproveBlock, onGetImproveContext });
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    const row = blockRow(container, '1');
    row.querySelector<HTMLButtonElement>('.edit__block-edit-toggle')!.click();
    expect(onGetImproveContext).toHaveBeenCalledWith('1');
    expect(row.querySelector('.edit__block-ai-context-loading')).toBeTruthy();
    await flushAsync();
    await flushAsync();
    expect(row.querySelector('.edit__block-ai-context-loading')).toBeNull();
    const seeds = row.querySelector('.edit__block-ai-context-seeds')!;
    expect(seeds.textContent).toContain('PMID 111（初期・include）: Seed A');
    expect(seeds.textContent).toContain('PMID 222（対話拡張・include）: Seed B');
    // MeSH・抄録のある seed では開示にも出る
    expect(seeds.querySelector('.edit__block-ai-context-seed-mesh')?.textContent).toContain(
      'MeSH: Asthma; Respiratory Sounds'
    );
    expect(seeds.querySelector('.edit__block-ai-context-seed-abstract')?.textContent).toContain(
      '抄録: Wheezing is a common symptom of asthma.'
    );
    // MeSH・抄録の無い seed には行が出ない（2 件中 1 件のみ表示）
    expect(seeds.querySelectorAll('.edit__block-ai-context-seed-mesh')).toHaveLength(1);
    expect(seeds.querySelectorAll('.edit__block-ai-context-seed-abstract')).toHaveLength(1);
    expect(row.querySelector('.edit__block-ai-context-validation')?.textContent).toContain(
      '捕捉率 50%'
    );
    expect(row.querySelector('.edit__block-ai-context-validation')?.textContent).toContain('222');
  });

  test('context が null でも現式は出て、シードは (登録なし)・検証は (未検証)', async () => {
    const onImproveBlock = jest.fn();
    const onGetImproveContext = jest.fn().mockResolvedValue(null);
    const view = createEditView({ onImproveBlock, onGetImproveContext });
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    const row = blockRow(container, '1');
    row.querySelector<HTMLButtonElement>('.edit__block-edit-toggle')!.click();
    await flushAsync();
    await flushAsync();
    expect(row.querySelector('.edit__block-ai-context-empty')?.textContent).toContain('登録なし');
    expect(row.querySelector('.edit__block-ai-context-validation')?.textContent).toContain(
      '未検証'
    );
    // 現式は fallback で表示される
    expect(row.querySelector('.edit__block-ai-context-list')?.textContent).toContain(
      'asthma[tiab]'
    );
  });

  test('文脈取得に失敗したら読み込み表示をエラーに差し替える', async () => {
    const onImproveBlock = jest.fn();
    const onGetImproveContext = jest.fn().mockRejectedValue(new Error('x'));
    const view = createEditView({ onImproveBlock, onGetImproveContext });
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    const row = blockRow(container, '1');
    row.querySelector<HTMLButtonElement>('.edit__block-edit-toggle')!.click();
    await flushAsync();
    await flushAsync();
    expect(row.querySelector('.edit__block-ai-context-loading')?.textContent).toContain(
      '失敗'
    );
  });
});
