import { INITIAL_STATE, type AppState, type BlockImprovementState } from '../store';
import { createEditView } from './editView';
import type { BlockImprovementContext, BlockImprovementResult } from '@/app/services';

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

describe('createEditView - ブロック単位 AI 改善（送信は fire-and-forget、結果は store 経由）', () => {
  test('AI ボタンでプロンプトフォームが開き、submit で onImproveBlock が指示付きで呼ばれる', () => {
    const onImproveBlock = jest.fn().mockResolvedValue(undefined);
    const view = createEditView({ onImproveBlock });
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    const row = blockRow(container, '1');
    row.querySelector<HTMLButtonElement>('.edit__block-improve')!.click();
    const instruction = row.querySelector<HTMLTextAreaElement>('.edit__block-ai-instruction')!;
    instruction.value = '同義語を増やして';
    row.querySelector<HTMLButtonElement>('.edit__block-ai-submit')!.click();
    // 新契約: view はこの呼び出しの解決値を使わない（結果は state.blockImprovement 経由）。
    expect(onImproveBlock).toHaveBeenCalledWith({ blockId: '1', instruction: '同義語を増やして' });
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

  test('onImproveBlock 未指定なら AI ボタンを押してもフォームは開かない', () => {
    const view = createEditView();
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    const row = blockRow(container, '1');
    const btn = row.querySelector<HTMLButtonElement>('.edit__block-improve')!;
    expect(() => btn.click()).not.toThrow();
    expect(row.querySelector('.edit__block-ai-form')).toBeNull();
  });
});

describe('createEditView - AI 改善の進捗・提案・エラーは state.blockImprovement から復元される（issue #39）', () => {
  const READY_RESULT: BlockImprovementResult = {
    blockId: '1',
    currentExpression: 'asthma[tiab]',
    proposedExpression: '"Asthma"[Mesh] OR asthma*[tiab]',
    rationale: 'MeSH 追加で感度向上',
  };

  function improvementFor(
    status: BlockImprovementState['status'],
    overrides: Partial<BlockImprovementState> = {}
  ): BlockImprovementState {
    return {
      formulaVersionId: 'v1',
      blockId: '1',
      status,
      result: status === 'ready' ? READY_RESULT : null,
      error: status === 'error' ? 'llm boom' : null,
      ...overrides,
    };
  }

  test('回帰: onImproveBlock 実行中に無関係な再描画が挟まっても、ready state になれば diff が表示される', () => {
    // 実運用では LLM コスト集計の setState が全ビュー再描画を起こし、旧実装はこの再描画で
    // .then() の宛先スロットが DOM から切り離されて提案が画面に反映されなかった（issue #39）。
    const onImproveBlock = jest.fn().mockReturnValue(new Promise<void>(() => undefined));
    const view = createEditView({ onImproveBlock });
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    const row = blockRow(container, '1');
    row.querySelector<HTMLButtonElement>('.edit__block-improve')!.click();
    const instruction = row.querySelector<HTMLTextAreaElement>('.edit__block-ai-instruction')!;
    instruction.value = '同義語を増やして';
    row.querySelector<HTMLButtonElement>('.edit__block-ai-submit')!.click();
    expect(onImproveBlock).toHaveBeenCalledWith({ blockId: '1', instruction: '同義語を増やして' });

    // 無関係な setState による全ビュー再描画をシミュレート（同じ container に再度 view を適用）。
    view(container, {
      state: { ...stateReadyFull, blockImprovement: improvementFor('running') },
      navigate: jest.fn(),
    });
    expect(blockRow(container, '1').querySelector('.edit__block-pending')).toBeTruthy();

    // LLM 完了後、bootstrap が status='ready' に更新した state で再描画された想定。
    view(container, {
      state: { ...stateReadyFull, blockImprovement: improvementFor('ready') },
      navigate: jest.fn(),
    });
    const finalRow = blockRow(container, '1');
    expect(finalRow.querySelector('.edit__block-rationale')?.textContent).toContain('MeSH 追加');
    expect(finalRow.querySelector('.edit__block-diff-before pre')?.textContent).toBe('asthma[tiab]');
    expect(finalRow.querySelector('.edit__block-diff-after pre')?.textContent).toBe(
      '"Asthma"[Mesh] OR asthma*[tiab]'
    );
    expect(finalRow.querySelector('.edit__block-accept')).toBeTruthy();
    expect(finalRow.querySelector('.edit__block-reject')).toBeTruthy();
  });

  test('running: .edit__block-pending が出て、対象ブロックの改善ボタンだけ disabled になる', () => {
    const view = createEditView({ onImproveBlock: jest.fn() });
    const container = buildContainer();
    view(container, {
      state: { ...stateReadyFull, blockImprovement: improvementFor('running') },
      navigate: jest.fn(),
    });
    const row1 = blockRow(container, '1');
    expect(row1.querySelector('.edit__block-pending')?.textContent).toContain('取得中');
    expect(row1.querySelector<HTMLButtonElement>('.edit__block-improve')!.disabled).toBe(true);
    const row2 = blockRow(container, '2');
    expect(row2.querySelector<HTMLButtonElement>('.edit__block-improve')!.disabled).toBe(false);
  });

  test('error: .edit__block-error にメッセージが出る', () => {
    const view = createEditView({ onImproveBlock: jest.fn() });
    const container = buildContainer();
    view(container, {
      state: { ...stateReadyFull, blockImprovement: improvementFor('error') },
      navigate: jest.fn(),
    });
    expect(blockRow(container, '1').querySelector('.edit__block-error')?.textContent).toContain(
      'llm boom'
    );
  });

  test('stale（formulaVersionId が現在の formula と不一致）な blockImprovement は描画されない', () => {
    const view = createEditView({ onImproveBlock: jest.fn() });
    const container = buildContainer();
    view(container, {
      state: {
        ...stateReadyFull,
        blockImprovement: improvementFor('ready', { formulaVersionId: 'old-v' }),
      },
      navigate: jest.fn(),
    });
    const row = blockRow(container, '1');
    expect(row.querySelector('.edit__block-rationale')).toBeNull();
    expect(row.querySelector<HTMLButtonElement>('.edit__block-improve')!.disabled).toBe(false);
  });

  test('提案が現式と同じなら accept が disabled', () => {
    const view = createEditView({ onImproveBlock: jest.fn() });
    const container = buildContainer();
    view(container, {
      state: {
        ...stateReadyFull,
        blockImprovement: improvementFor('ready', {
          result: {
            blockId: '1',
            currentExpression: 'asthma[tiab]',
            proposedExpression: 'asthma[tiab]',
            rationale: '改善余地無し',
          },
        }),
      },
      navigate: jest.fn(),
    });
    expect(
      blockRow(container, '1').querySelector<HTMLButtonElement>('.edit__block-accept')!.disabled
    ).toBe(true);
  });

  test('提案が空文字でも accept は disabled、rationale 空文字は代替テキストで表示', () => {
    const view = createEditView({ onImproveBlock: jest.fn() });
    const container = buildContainer();
    view(container, {
      state: {
        ...stateReadyFull,
        blockImprovement: improvementFor('ready', {
          result: {
            blockId: '1',
            currentExpression: 'asthma[tiab]',
            proposedExpression: '',
            rationale: '',
          },
        }),
      },
      navigate: jest.fn(),
    });
    const row = blockRow(container, '1');
    expect(row.querySelector<HTMLButtonElement>('.edit__block-accept')!.disabled).toBe(true);
    expect(row.querySelector('.edit__block-rationale')?.textContent).toContain('（改善ポイント');
  });

  test('accept: onDraftChange が置換後 md 全文で呼ばれ、onClearImprovement も呼ばれる', () => {
    const onDraftChange = jest.fn();
    const onClearImprovement = jest.fn();
    const view = createEditView({
      onImproveBlock: jest.fn(),
      onDraftChange,
      onClearImprovement,
    });
    const container = buildContainer();
    view(container, {
      state: { ...stateReadyFull, blockImprovement: improvementFor('ready') },
      navigate: jest.fn(),
    });
    blockRow(container, '1').querySelector<HTMLButtonElement>('.edit__block-accept')!.click();
    expect(onDraftChange).toHaveBeenCalledTimes(1);
    expect(onDraftChange.mock.calls[0]![0]).toContain('#1 "Asthma"[Mesh] OR asthma*[tiab]');
    expect(onClearImprovement).toHaveBeenCalledTimes(1);
  });

  test('accept: onDraftChange 未指定ならローカル再描画で反映される（フォールバック）', () => {
    const onClearImprovement = jest.fn();
    const view = createEditView({ onImproveBlock: jest.fn(), onClearImprovement });
    const container = buildContainer();
    view(container, {
      state: { ...stateReadyFull, blockImprovement: improvementFor('ready') },
      navigate: jest.fn(),
    });
    blockRow(container, '1').querySelector<HTMLButtonElement>('.edit__block-accept')!.click();
    expect(blockRow(container, '1').querySelector('.edit__block-current')?.textContent).toBe(
      '"Asthma"[Mesh] OR asthma*[tiab]'
    );
    expect(blockRow(container, '2').querySelector('.edit__block-current')?.textContent).toBe(
      'children[tiab]'
    );
    expect(onClearImprovement).toHaveBeenCalledTimes(1);
  });

  test('reject: onClearImprovement が呼ばれる', () => {
    const onClearImprovement = jest.fn();
    const view = createEditView({ onImproveBlock: jest.fn(), onClearImprovement });
    const container = buildContainer();
    view(container, {
      state: { ...stateReadyFull, blockImprovement: improvementFor('ready') },
      navigate: jest.fn(),
    });
    blockRow(container, '1').querySelector<HTMLButtonElement>('.edit__block-reject')!.click();
    expect(onClearImprovement).toHaveBeenCalledTimes(1);
  });

  test('改善ボタンのトグルで ready の提案を閉じると onClearImprovement が呼ばれ、DOM も消える', () => {
    const onClearImprovement = jest.fn();
    const view = createEditView({ onImproveBlock: jest.fn(), onClearImprovement });
    const container = buildContainer();
    view(container, {
      state: { ...stateReadyFull, blockImprovement: improvementFor('ready') },
      navigate: jest.fn(),
    });
    const row = blockRow(container, '1');
    expect(row.querySelector('.edit__block-diff')).toBeTruthy();
    row.querySelector<HTMLButtonElement>('.edit__block-improve')!.click();
    expect(row.querySelector('.edit__block-diff')).toBeNull();
    expect(onClearImprovement).toHaveBeenCalledTimes(1);
  });

  test('改善ボタンのトグルで未送信のプロンプト入力フォームを閉じても onClearImprovement は呼ばれない', () => {
    // store 上の提案（blockImprovement）が無い状態でプロンプト欄だけ開いて閉じるケース。
    // 他ブロックの編集中の状態を巻き込む全ビュー再描画を無駄に誘発しないことの回帰確認。
    const onClearImprovement = jest.fn();
    const view = createEditView({ onImproveBlock: jest.fn(), onClearImprovement });
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    const row = blockRow(container, '1');
    const btn = row.querySelector<HTMLButtonElement>('.edit__block-improve')!;
    btn.click();
    expect(row.querySelector('.edit__block-ai-form')).toBeTruthy();
    btn.click();
    expect(row.querySelector('.edit__block-ai-form')).toBeNull();
    expect(onClearImprovement).not.toHaveBeenCalled();
  });

  test('reject（フォールバック）: onClearImprovement 未指定でも DOM が消え、以後のローカル再描画でも復活しない', () => {
    const view = createEditView({ onImproveBlock: jest.fn() });
    const container = buildContainer();
    view(container, {
      state: { ...stateReadyFull, blockImprovement: improvementFor('ready') },
      navigate: jest.fn(),
    });
    blockRow(container, '1').querySelector<HTMLButtonElement>('.edit__block-reject')!.click();
    expect(blockRow(container, '1').querySelector('.edit__block-diff')).toBeNull();

    // 他ブロックの鉛筆編集保存でローカル rerenderBlocks を誘発する。
    const row2 = blockRow(container, '2');
    row2.querySelector<HTMLButtonElement>('.edit__block-edit-toggle')!.click();
    const input = blockRow(container, '2').querySelector<HTMLTextAreaElement>(
      '.edit__block-edit-input'
    )!;
    input.value = 'children2[tiab]';
    blockRow(container, '2').querySelector<HTMLButtonElement>('.edit__block-edit-save')!.click();

    // ブロック #1 の提案は復活しない。
    const row1After = blockRow(container, '1');
    expect(row1After.querySelector('.edit__block-diff')).toBeNull();
    expect(row1After.querySelector('.edit__block-rationale')).toBeNull();
  });

  test('accept（フォールバック）: onClearImprovement 未指定でも、置換後の再描画で古い提案が復活しない', () => {
    const view = createEditView({ onImproveBlock: jest.fn() });
    const container = buildContainer();
    view(container, {
      state: { ...stateReadyFull, blockImprovement: improvementFor('ready') },
      navigate: jest.fn(),
    });
    blockRow(container, '1').querySelector<HTMLButtonElement>('.edit__block-accept')!.click();
    const row1 = blockRow(container, '1');
    expect(row1.querySelector('.edit__block-current')?.textContent).toBe(
      '"Asthma"[Mesh] OR asthma*[tiab]'
    );
    expect(row1.querySelector('.edit__block-diff')).toBeNull();
    expect(row1.querySelector('.edit__block-rationale')).toBeNull();
  });
});

describe('createEditView - 編集中 md は state から解決される（formulaEditDraft）', () => {
  test('formulaEditDraft が現在の formula バージョンと一致すればそちらの md を表示する', () => {
    const view = createEditView();
    const container = buildContainer();
    const draftMd = [
      '## PubMed/MEDLINE',
      '',
      '```',
      '#1 DRAFT-EXPRESSION',
      '#2 children[tiab]',
      '#3 #1 AND #2',
      '```',
      '',
    ].join('\n');
    view(container, {
      state: { ...stateReadyFull, formulaEditDraft: { formulaVersionId: 'v1', markdown: draftMd } },
      navigate: jest.fn(),
    });
    expect(blockRow(container, '1').querySelector('.edit__block-current')?.textContent).toBe(
      'DRAFT-EXPRESSION'
    );
  });

  test('formulaEditDraft が別バージョン（stale）なら currentFormulaMarkdown にフォールバックする', () => {
    const view = createEditView();
    const container = buildContainer();
    view(container, {
      state: {
        ...stateReadyFull,
        formulaEditDraft: {
          formulaVersionId: 'old-v',
          markdown: '## PubMed/MEDLINE\n\n```\n#1 STALE\n```\n',
        },
      },
      navigate: jest.fn(),
    });
    expect(blockRow(container, '1').querySelector('.edit__block-current')?.textContent).toBe(
      'asthma[tiab]'
    );
  });

  test('鉛筆の手編集: onDraftChange が新しい md 全文で呼ばれる', () => {
    const onDraftChange = jest.fn();
    const view = createEditView({ onDraftChange });
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
    expect(onDraftChange).toHaveBeenCalledTimes(1);
    expect(onDraftChange.mock.calls[0]![0]).toContain('#1 "Asthma"[Mesh]');
    expect(onDraftChange.mock.calls[0]![0]).toContain('#2 children[tiab]');
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
