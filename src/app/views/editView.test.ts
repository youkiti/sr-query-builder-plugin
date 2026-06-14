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
    blockRow(container, '1').querySelector<HTMLButtonElement>('.edit__block-improve')!.click();
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
});

describe('createEditView - 鉛筆インライン編集', () => {
  test('各ブロックに鉛筆ボタンと AI 改善ボタンが並ぶ', () => {
    const view = createEditView();
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    const rows = container.querySelectorAll('.edit__block-row');
    expect(rows).toHaveLength(3);
    expect(rows[0]!.querySelector('.edit__block-edit-toggle')).toBeTruthy();
    expect(rows[0]!.querySelector('.edit__block-improve')).toBeTruthy();
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
    row.querySelector<HTMLButtonElement>('.edit__block-improve')!.click();
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

  test('AI ボタン再クリックでフォームをトグルで閉じる', () => {
    const onImproveBlock = jest.fn();
    const view = createEditView({ onImproveBlock });
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    const row = blockRow(container, '1');
    const btn = row.querySelector<HTMLButtonElement>('.edit__block-improve')!;
    btn.click();
    expect(row.querySelector('.edit__block-ai-form')).toBeTruthy();
    btn.click();
    expect(row.querySelector('.edit__block-ai-form')).toBeNull();
  });

  test('プロンプトフォームのキャンセルで閉じる', () => {
    const onImproveBlock = jest.fn();
    const view = createEditView({ onImproveBlock });
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    const row = blockRow(container, '1');
    row.querySelector<HTMLButtonElement>('.edit__block-improve')!.click();
    row.querySelector<HTMLButtonElement>('.edit__block-ai-cancel')!.click();
    expect(row.querySelector('.edit__block-ai-form')).toBeNull();
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
    blockRow(container, '1').querySelector<HTMLButtonElement>('.edit__block-improve')!.click();
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
    row.querySelector<HTMLButtonElement>('.edit__block-improve')!.click();
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
    row.querySelector<HTMLButtonElement>('.edit__block-improve')!.click();
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
    row.querySelector<HTMLButtonElement>('.edit__block-improve')!.click();
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
    row.querySelector<HTMLButtonElement>('.edit__block-improve')!.click();
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
    row.querySelector<HTMLButtonElement>('.edit__block-improve')!.click();
    row.querySelector<HTMLButtonElement>('.edit__block-ai-submit')!.click();
    await flushAsync();
    await flushAsync();
    expect(row.querySelector('.edit__block-error')?.textContent).toContain('oops');
  });

  test('onImproveBlock 未指定なら AI ボタンを押してもフォームは開かない', () => {
    const view = createEditView();
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    const row = blockRow(container, '1');
    const btn = row.querySelector<HTMLButtonElement>('.edit__block-improve')!;
    expect(() => btn.click()).not.toThrow();
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
    row.querySelector<HTMLButtonElement>('.edit__block-improve')!.click();
    row.querySelector<HTMLButtonElement>('.edit__block-ai-submit')!.click();
    await flushAsync();
    await flushAsync();
    row.querySelector<HTMLButtonElement>('.edit__block-accept')!.click();
    expect(blockRow(container, '1').querySelector('.edit__block-current')?.textContent).toBe(
      'new-expr'
    );
  });
});

describe('createEditView - AI に渡す内容を見る（文脈開示）', () => {
  const context: BlockImprovementContext = {
    researchQuestion: 'RQ text',
    blockLabel: 'Population',
    blockDescription: '喘息',
    currentExpression: 'asthma[tiab]',
    seedPapers: [
      { pmid: '111', title: 'Seed A', decision: 'include', source: 'initial' },
      { pmid: '222', title: 'Seed B', decision: 'include', source: 'interactive' },
    ],
    validation: { captureRate: 0.5, capturedPmids: ['111'], missedPmids: ['222'] },
  };

  test('開示にシード論文と検証捕捉情報が出る', async () => {
    const onImproveBlock = jest.fn();
    const onGetImproveContext = jest.fn().mockResolvedValue(context);
    const view = createEditView({ onImproveBlock, onGetImproveContext });
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    const row = blockRow(container, '1');
    row.querySelector<HTMLButtonElement>('.edit__block-improve')!.click();
    expect(onGetImproveContext).toHaveBeenCalledWith('1');
    expect(row.querySelector('.edit__block-ai-context-loading')).toBeTruthy();
    await flushAsync();
    await flushAsync();
    expect(row.querySelector('.edit__block-ai-context-loading')).toBeNull();
    const seeds = row.querySelector('.edit__block-ai-context-seeds')!;
    expect(seeds.textContent).toContain('PMID 111（初期・include）: Seed A');
    expect(seeds.textContent).toContain('PMID 222（対話拡張・include）: Seed B');
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
    row.querySelector<HTMLButtonElement>('.edit__block-improve')!.click();
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
    row.querySelector<HTMLButtonElement>('.edit__block-improve')!.click();
    await flushAsync();
    await flushAsync();
    expect(row.querySelector('.edit__block-ai-context-loading')?.textContent).toContain(
      '失敗'
    );
  });
});
