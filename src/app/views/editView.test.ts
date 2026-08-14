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

  test('保存ボタン押下で onSave が現在の md とメモ（入力欄の現在値）付きで呼ばれる', async () => {
    const onSave = jest.fn().mockResolvedValue(undefined);
    const view = createEditView({ onSave });
    const container = buildContainer();
    view(container, { state: stateReady, navigate: jest.fn() });
    const noteInput = container.querySelector<HTMLInputElement>('.edit__note-input')!;
    // change 未発火（＝store 未反映）の打鍵でも、保存内容には含める
    noteInput.value = 'メモ';
    const saveBtn = container.querySelector<HTMLButtonElement>('.edit__actions button')!;
    saveBtn.click();
    await flushAsync();
    expect(onSave).toHaveBeenCalledWith({
      formulaMd: stateReady.currentFormulaMarkdown,
      note: 'メモ',
    });
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

describe('createEditView - 保存ステータス / 編集メモ（issue #42）', () => {
  test('formulaSave=saved を store から復元して「保存しました」を出す', () => {
    const view = createEditView({ onSave: jest.fn() });
    const container = buildContainer();
    // 保存成功後の state（version は採番された新しい版へ移っている）
    view(container, {
      state: {
        ...stateReady,
        currentFormulaVersionId: 'v2',
        formulaSave: { formulaVersionId: 'v2', status: 'saved', error: null },
      },
      navigate: jest.fn(),
    });
    expect(container.querySelector('.edit__status')?.textContent).toBe(
      '保存しました（version_id: v2）'
    );
    expect(container.querySelector('.edit__error')?.textContent).toBe('');
    // 再描画されても消えない（＝ issue #42 の回帰確認）
    view(container, {
      state: {
        ...stateReady,
        currentFormulaVersionId: 'v2',
        formulaSave: { formulaVersionId: 'v2', status: 'saved', error: null },
      },
      navigate: jest.fn(),
    });
    expect(container.querySelector('.edit__status')?.textContent).toContain('v2');
  });

  test('formulaSave=saving は「保存中…」と保存ボタン disabled', () => {
    const view = createEditView({ onSave: jest.fn() });
    const container = buildContainer();
    view(container, {
      state: {
        ...stateReady,
        formulaSave: { formulaVersionId: 'v1', status: 'saving', error: null },
      },
      navigate: jest.fn(),
    });
    expect(container.querySelector('.edit__status')?.textContent).toBe('保存中…');
    expect(container.querySelector<HTMLButtonElement>('.edit__actions button')!.disabled).toBe(
      true
    );
  });

  test('formulaSave=error はエラー行に出し、status は空にする', () => {
    const view = createEditView({ onSave: jest.fn() });
    const container = buildContainer();
    view(container, {
      state: {
        ...stateReady,
        formulaSave: { formulaVersionId: 'v1', status: 'error', error: 'boom' },
      },
      navigate: jest.fn(),
    });
    expect(container.querySelector('.edit__error')?.textContent).toBe('boom');
    expect(container.querySelector('.edit__status')?.textContent).toBe('');
    expect(container.querySelector<HTMLButtonElement>('.edit__actions button')!.disabled).toBe(
      false
    );
  });

  test('formulaSave=error でメッセージ欠落時は「不明なエラー」', () => {
    const view = createEditView({ onSave: jest.fn() });
    const container = buildContainer();
    view(container, {
      state: {
        ...stateReady,
        formulaSave: { formulaVersionId: 'v1', status: 'error', error: null },
      },
      navigate: jest.fn(),
    });
    expect(container.querySelector('.edit__error')?.textContent).toBe('不明なエラー');
  });

  test('別バージョンの formulaSave（stale）は表示しない', () => {
    const view = createEditView({ onSave: jest.fn() });
    const container = buildContainer();
    view(container, {
      state: {
        ...stateReady,
        formulaSave: { formulaVersionId: 'other', status: 'saved', error: null },
      },
      navigate: jest.fn(),
    });
    expect(container.querySelector('.edit__status')?.textContent).toBe('');
    expect(container.querySelector('.edit__error')?.textContent).toBe('');
  });

  test('編集メモは formulaEditNote から復元され、stale なら空', () => {
    const view = createEditView();
    const container = buildContainer();
    view(container, {
      state: { ...stateReady, formulaEditNote: { formulaVersionId: 'v1', note: '前回のメモ' } },
      navigate: jest.fn(),
    });
    expect(container.querySelector<HTMLInputElement>('.edit__note-input')!.value).toBe(
      '前回のメモ'
    );
    // 保存後は版が変わり stale になるのでメモは残らない
    view(container, {
      state: {
        ...stateReady,
        currentFormulaVersionId: 'v2',
        formulaEditNote: { formulaVersionId: 'v1', note: '前回のメモ' },
      },
      navigate: jest.fn(),
    });
    expect(container.querySelector<HTMLInputElement>('.edit__note-input')!.value).toBe('');
  });

  test('編集メモは打鍵（input）のたびに onNoteChange を呼ぶ（change には依存しない）', () => {
    const onNoteChange = jest.fn();
    const view = createEditView({ onNoteChange });
    const container = buildContainer();
    view(container, { state: stateReady, navigate: jest.fn() });
    const noteInput = container.querySelector<HTMLInputElement>('.edit__note-input')!;
    noteInput.value = '書きかけ';
    // change だけでは呼ばれない（listener が input に切り替わったことの確認。PR #43 の回帰対応）
    noteInput.dispatchEvent(new Event('change'));
    expect(onNoteChange).not.toHaveBeenCalled();
    noteInput.dispatchEvent(new Event('input'));
    expect(onNoteChange).toHaveBeenCalledWith('書きかけ');
  });

  test('onNoteChange 未指定でも input で例外にならない', () => {
    const view = createEditView();
    const container = buildContainer();
    view(container, { state: stateReady, navigate: jest.fn() });
    const noteInput = container.querySelector<HTMLInputElement>('.edit__note-input')!;
    expect(() =>
      noteInput.dispatchEvent(new Event('input'))
    ).not.toThrow();
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

describe('createEditView - ブロック・インスペクタの配線（issue #58 chunk 3a）', () => {
  test('計測 callback 未指定なら鉛筆を開いてもインスペクタは出ない', () => {
    const view = createEditView();
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    const row = blockRow(container, '1');
    row.querySelector<HTMLButtonElement>('.edit__block-edit-toggle')!.click();
    expect(row.querySelector('.edit__block-inspector .bins')).toBeNull();
  });

  test('鉛筆クリックでそのブロックの下にインスペクタが展開し、再クリックで閉じる', () => {
    const onCountHits = jest.fn().mockResolvedValue(10);
    const view = createEditView({ onCountHits });
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    const row = blockRow(container, '1');
    expect(row.querySelector('.edit__block-inspector .bins')).toBeNull();
    const toggle = row.querySelector<HTMLButtonElement>('.edit__block-edit-toggle')!;
    toggle.click();
    expect(row.querySelector('.edit__block-inspector .bins')).toBeTruthy();
    // インスペクタ用スロットは行内の最後の子（編集フォーム・AI パネルより下）
    expect(row.lastElementChild?.className).toBe('edit__block-inspector');
    toggle.click();
    expect(row.querySelector('.edit__block-inspector .bins')).toBeNull();
  });

  test('AI 改善ボタンでもインスペクタが展開する（未送信の指示入力中でも）', () => {
    const onCountHits = jest.fn().mockResolvedValue(1);
    const view = createEditView({ onCountHits, onImproveBlock: jest.fn() });
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    const row = blockRow(container, '1');
    const btn = row.querySelector<HTMLButtonElement>('.edit__block-improve')!;
    btn.click();
    expect(row.querySelector('.edit__block-inspector .bins')).toBeTruthy();
    btn.click();
    expect(row.querySelector('.edit__block-inspector .bins')).toBeNull();
  });

  test('AI プロンプトフォームのキャンセルでもインスペクタが閉じる', () => {
    const onCountHits = jest.fn().mockResolvedValue(1);
    const view = createEditView({ onCountHits, onImproveBlock: jest.fn() });
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    const row = blockRow(container, '1');
    row.querySelector<HTMLButtonElement>('.edit__block-improve')!.click();
    expect(row.querySelector('.edit__block-inspector .bins')).toBeTruthy();
    row.querySelector<HTMLButtonElement>('.edit__block-ai-cancel')!.click();
    expect(row.querySelector('.edit__block-inspector .bins')).toBeNull();
  });

  test('回帰: ready 提案をトグルで閉じるとき、openBlocks の削除は onClearImprovement の同期再描画より前でなければならない（順序が入れ替わると検出する）', () => {
    // onClearImprovement は bootstrap では store.setState を呼び、store.setState はリスナへ
    // 同期的に通知する（store.ts の createStore 参照）ため、editView の全ビュー再描画が
    // onClearImprovement() の呼び出し「中」に起きる。ここでは同じ挙動を手元で再現する：
    // 呼ばれた瞬間に（呼び出し元へ制御が戻るより前に）view() を再実行し、新しい行を作る。
    //
    // openBlocks に blockId を「AI 改善ボタン（鉛筆ではなく）で開いたことにより」乗せておく
    // 点が重要: state.blockImprovement だけが理由でインスペクタが開いているケース（クリック
    // 一切なし）だと、`isInspectorOpen` は improvement!==null の分岐だけで真になり、
    // openBlocks の中身は最初から空のまま＝削除の順序を変えても結果が変わらず、
    // このテストが「順序を戻したら落ちる」性質を持たなくなってしまう。
    const container = buildContainer();
    const onCountHits = jest.fn().mockResolvedValue(1);
    let latestState: AppState = { ...stateReadyFull, blockImprovement: null };
    const onImproveBlock = jest.fn().mockResolvedValue(undefined);
    const onClearImprovement = jest.fn(() => {
      latestState = { ...latestState, blockImprovement: null };
      view(container, { state: latestState, navigate: jest.fn() });
    });
    const view = createEditView({ onCountHits, onImproveBlock, onClearImprovement });
    view(container, { state: latestState, navigate: jest.fn() });

    // 1. 「AI に改善させる」でプロンプトフォームを開く（未送信）→ openBlocks に '1' が乗る。
    blockRow(container, '1').querySelector<HTMLButtonElement>('.edit__block-improve')!.click();
    expect(blockRow(container, '1').querySelector('.edit__block-inspector .bins')).toBeTruthy();

    // 2. LLM 完了で store.blockImprovement が ready になった想定の再描画。
    //    inspector（openBlocks を含む）は createEditView インスタンスの外側クロージャに
    //    あるので、この再描画をまたいでも '1' は残ったまま。
    latestState = {
      ...latestState,
      blockImprovement: {
        formulaVersionId: 'v1',
        blockId: '1',
        status: 'ready',
        result: {
          blockId: '1',
          currentExpression: 'asthma[tiab]',
          proposedExpression: '"Asthma"[Mesh]',
          rationale: 'r',
        },
        error: null,
      },
    };
    view(container, { state: latestState, navigate: jest.fn() });
    expect(blockRow(container, '1').querySelector('.edit__block-inspector .bins')).toBeTruthy();

    // 3. 「AI に改善させる」の再クリック（ready パネルを閉じるトグル分岐）が
    //    onClearImprovement 経由で同期的に行を作り直す。鉛筆は一度も開いていないので
    //    editSlot は常に空 = openBlocks からの削除条件は満たされている。
    blockRow(container, '1').querySelector<HTMLButtonElement>('.edit__block-improve')!.click();

    expect(onClearImprovement).toHaveBeenCalledTimes(1);
    // openBlocks の削除が onClearImprovement() より後回しだと、同期再描画で作られる
    // 新しい行はまだ '1' が残った openBlocks を読み、インスペクタが閉じない。
    expect(blockRow(container, '1').querySelector('.edit__block-inspector .bins')).toBeNull();
  });

  test('store.blockImprovement が非 null（running/ready/error）ならクリックなしでもインスペクタが出る', () => {
    const onCountHits = jest.fn().mockResolvedValue(1);
    const view = createEditView({ onCountHits });
    const container = buildContainer();
    view(container, {
      state: {
        ...stateReadyFull,
        blockImprovement: {
          formulaVersionId: 'v1',
          blockId: '1',
          status: 'running',
          result: null,
          error: null,
        },
      },
      navigate: jest.fn(),
    });
    expect(blockRow(container, '1').querySelector('.edit__block-inspector .bins')).toBeTruthy();
    // 別ブロックには波及しない
    expect(blockRow(container, '2').querySelector('.edit__block-inspector .bins')).toBeNull();
  });

  test('回帰: 鉛筆で開いたインスペクタは無関係な再描画（他ブロックの AI 改善開始）をまたいで残る', () => {
    // editView は再描画のたびに container.innerHTML='' で丸ごと作り直すため、開閉状態を
    // ローカル変数だけに持つと issue #39 / #42 と同型の回帰（無関係な setState で消える）になる。
    const onCountHits = jest.fn().mockResolvedValue(1);
    const view = createEditView({ onCountHits });
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    blockRow(container, '1').querySelector<HTMLButtonElement>('.edit__block-edit-toggle')!.click();
    expect(blockRow(container, '1').querySelector('.edit__block-inspector .bins')).toBeTruthy();

    // 無関係な再描画（例: ブロック #2 の AI 改善が running になった）を模擬する。
    view(container, {
      state: {
        ...stateReadyFull,
        blockImprovement: {
          formulaVersionId: 'v1',
          blockId: '2',
          status: 'running',
          result: null,
          error: null,
        },
      },
      navigate: jest.fn(),
    });
    expect(blockRow(container, '1').querySelector('.edit__block-inspector .bins')).toBeTruthy();
  });

  test('ヒット数キャッシュは再描画をまたいで共有される（同じ式を再 esearch しない）', async () => {
    const onCountHits = jest.fn().mockResolvedValue(42);
    const view = createEditView({ onCountHits });
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    const toggle = blockRow(container, '1').querySelector<HTMLButtonElement>(
      '.edit__block-edit-toggle'
    )!;
    toggle.click();
    await flushAsync();
    const callsAfterFirstOpen = onCountHits.mock.calls.length;
    expect(callsAfterFirstOpen).toBeGreaterThan(0);

    // 閉じて再度開く（同じ createEditView インスタンス＝同じキャッシュを共有する）。
    toggle.click();
    toggle.click();
    await flushAsync();
    expect(onCountHits.mock.calls.length).toBe(callsAfterFirstOpen);
  });

  test('siblings は結合行を除いた他ブロックから組み立てられる（他ブロックとの重複セクション）', async () => {
    const onCountHits = jest.fn().mockResolvedValue(1);
    const view = createEditView({ onCountHits });
    const container = buildContainer();
    const md = [
      '## PubMed/MEDLINE',
      '',
      '```',
      '#1 asthma[tiab]',
      '#2 asthma[tiab]',
      '#3 #1 AND #2',
      '```',
      '',
    ].join('\n');
    view(container, { state: { ...stateReady, currentFormulaMarkdown: md }, navigate: jest.fn() });
    blockRow(container, '1').querySelector<HTMLButtonElement>('.edit__block-edit-toggle')!.click();
    await flushAsync();
    const overlap = blockRow(container, '1').querySelector('.bins__overlap-line')?.textContent;
    // #2 と同じフリーワードを共有しているので重複行に出る。結合行 #3 は比較対象に含まない。
    expect(overlap).toContain('#2');
    expect(overlap).not.toContain('#3');
  });
});

const CHIP_MD = [
  '## PubMed/MEDLINE',
  '',
  '```',
  '#1 asthma[tiab] OR "Asthma"[Mesh]',
  '#2 children[tiab]',
  '#3 #1 AND #2',
  '```',
  '',
].join('\n');

const stateReadyChips: AppState = {
  ...stateReady,
  currentFormulaMarkdown: CHIP_MD,
};

describe('createEditView - チップ編集（issue #58 chunk 3b）', () => {
  test('鉛筆を開くと句単位のチップが表示される（MeSH はリンク、フリーワードは編集ボタン）', () => {
    const view = createEditView();
    const container = buildContainer();
    view(container, { state: stateReadyChips, navigate: jest.fn() });
    const row = blockRow(container, '1');
    row.querySelector<HTMLButtonElement>('.edit__block-edit-toggle')!.click();
    expect(row.querySelector('.edit__block-chips')).toBeTruthy();
    expect(row.querySelector('.edit__chip--mesh a.edit__chip-term--mesh')).toBeTruthy();
    expect(row.querySelector('.edit__chip--freeword .edit__chip-term--editable')?.textContent).toBe(
      'asthma[tiab]'
    );
    // 読み取り表示（.edit__block-current）は編集面が開いている間隠れる
    expect((row.querySelector('.edit__block-current') as HTMLElement).style.display).toBe('none');
  });

  test('チップの × で句を削除すると onDraftChange が更新後の md で呼ばれる（他ブロックは維持）', () => {
    const onDraftChange = jest.fn();
    const view = createEditView({ onDraftChange });
    const container = buildContainer();
    view(container, { state: stateReadyChips, navigate: jest.fn() });
    blockRow(container, '1').querySelector<HTMLButtonElement>('.edit__block-edit-toggle')!.click();
    blockRow(container, '1').querySelector<HTMLButtonElement>('.edit__chip-remove')!.click();
    expect(onDraftChange).toHaveBeenCalledTimes(1);
    expect(onDraftChange.mock.calls[0]![0]).toContain('#1 "Asthma"[Mesh]');
    expect(onDraftChange.mock.calls[0]![0]).toContain('#2 children[tiab]');
  });

  test('フリーワードチップの語編集（Enter）で onDraftChange が更新後の md で呼ばれる', () => {
    const onDraftChange = jest.fn();
    const view = createEditView({ onDraftChange });
    const container = buildContainer();
    view(container, { state: stateReadyChips, navigate: jest.fn() });
    blockRow(container, '1').querySelector<HTMLButtonElement>('.edit__block-edit-toggle')!.click();
    const termBtn = blockRow(container, '1').querySelector<HTMLButtonElement>(
      '.edit__chip-term--editable'
    )!;
    termBtn.click();
    const input = blockRow(container, '1').querySelector<HTMLInputElement>('.edit__chip-input')!;
    input.value = 'asthma*';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(onDraftChange).toHaveBeenCalledTimes(1);
    expect(onDraftChange.mock.calls[0]![0]).toContain('#1 asthma*[tiab] OR "Asthma"[Mesh]');
  });

  test('「＋ 語を追加」で onDraftChange が更新後の md で呼ばれる', () => {
    const onDraftChange = jest.fn();
    const view = createEditView({ onDraftChange });
    const container = buildContainer();
    view(container, { state: stateReadyChips, navigate: jest.fn() });
    blockRow(container, '1').querySelector<HTMLButtonElement>('.edit__block-edit-toggle')!.click();
    blockRow(container, '1').querySelector<HTMLButtonElement>('.edit__chip-add-btn')!.click();
    const input = blockRow(container, '1').querySelector<HTMLInputElement>(
      '.edit__chip-add-input'
    )!;
    input.value = 'wheeze';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(onDraftChange).toHaveBeenCalledTimes(1);
    expect(onDraftChange.mock.calls[0]![0]).toContain('wheeze[tiab]');
  });

  test('最後の 1 語を削除すると拒否され、onDraftChange は呼ばれない（ブロックが空になるため）', () => {
    const onDraftChange = jest.fn();
    const view = createEditView({ onDraftChange });
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() }); // #1 は 'asthma[tiab]' の 1 語のみ
    const row = blockRow(container, '1');
    row.querySelector<HTMLButtonElement>('.edit__block-edit-toggle')!.click();
    row.querySelector<HTMLButtonElement>('.edit__chip-remove')!.click();
    expect(onDraftChange).not.toHaveBeenCalled();
    expect(row.querySelector('.edit__block-chips-error')?.textContent).toContain(
      '空にすることはできません'
    );
    // チップ自体は消えていない（コミットされず、元の式のまま）
    expect(row.querySelector('.edit__chip-remove')).toBeTruthy();
  });

  // buildContainer() は document.implementation.createHTMLDocument() で作った、window
  // （ブラウジングコンテキスト）を持たない独立ドキュメントを使う。jsdom はこの種の
  // ドキュメントで .focus() を呼んでも activeElement を更新しない（このファイルの他の
  // どのテストも document.activeElement を検証していないのはこの制約のため）。
  // そのため、実際に focus されたかどうかは HTMLElement.prototype.focus をスパイして
  // 「どの要素に対して呼ばれたか」で検証する（本物のブラウザ / Playwright では
  // activeElement は正しく更新される）。
  test('フォーカス復元: 語編集の確定後は同じ語のチップへフォーカスが戻る（フォールバック経路）', () => {
    const focusSpy = jest.spyOn(HTMLElement.prototype, 'focus');
    const view = createEditView();
    const container = buildContainer();
    view(container, { state: stateReadyChips, navigate: jest.fn() });
    blockRow(container, '1').querySelector<HTMLButtonElement>('.edit__block-edit-toggle')!.click();
    const termBtn = blockRow(container, '1').querySelector<HTMLButtonElement>(
      '.edit__chip-term--editable'
    )!;
    termBtn.click();
    const input = blockRow(container, '1').querySelector<HTMLInputElement>('.edit__chip-input')!;
    input.value = 'asthma*';
    focusSpy.mockClear(); // ここまでの focus() 呼び出し（chip 編集開始時の input.focus() 等）を除外
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    const newRow = blockRow(container, '1');
    const restoredChip = Array.from(newRow.querySelectorAll<HTMLElement>('.edit__chip')).find(
      (c) => c.getAttribute('data-operand-term') === 'asthma*'
    );
    const restoredTarget = restoredChip?.querySelector('.edit__chip-term--editable');
    expect(focusSpy).toHaveBeenCalledWith();
    expect(focusSpy.mock.instances).toContain(restoredTarget);
    focusSpy.mockRestore();
  });

  test('フォーカス復元: 削除後は「＋ 語を追加」ボタンへフォーカスが戻る（フォールバック経路）', () => {
    const focusSpy = jest.spyOn(HTMLElement.prototype, 'focus');
    const view = createEditView();
    const container = buildContainer();
    view(container, { state: stateReadyChips, navigate: jest.fn() });
    const row = blockRow(container, '1');
    row.querySelector<HTMLButtonElement>('.edit__block-edit-toggle')!.click();
    focusSpy.mockClear();
    row.querySelector<HTMLButtonElement>('.edit__chip-remove')!.click();
    const newRow = blockRow(container, '1');
    expect(focusSpy.mock.instances).toContain(newRow.querySelector('.edit__chip-add-btn'));
    focusSpy.mockRestore();
  });
});

describe('createEditView - クイック整理（重複整理 / MeSH 先頭。issue #58 chunk 3b）', () => {
  test('重複が無ければ「重複を整理」は disabled', () => {
    const view = createEditView();
    const container = buildContainer();
    view(container, { state: stateReadyChips, navigate: jest.fn() });
    const row = blockRow(container, '1');
    row.querySelector<HTMLButtonElement>('.edit__block-edit-toggle')!.click();
    const dedupeBtn = Array.from(row.querySelectorAll<HTMLButtonElement>('.edit__block-quicktool')).find(
      (b) => b.textContent === '重複する語を整理'
    )!;
    expect(dedupeBtn.disabled).toBe(true);
  });

  test('重複がある式では「重複を整理」が有効で、クリックで dedupeOperands の結果が commit される', () => {
    const onDraftChange = jest.fn();
    const view = createEditView({ onDraftChange });
    const container = buildContainer();
    const md = [
      '## PubMed/MEDLINE',
      '',
      '```',
      '#1 asthma[tiab] OR asthma[tiab]',
      '```',
      '',
    ].join('\n');
    view(container, { state: { ...stateReady, currentFormulaMarkdown: md }, navigate: jest.fn() });
    const row = blockRow(container, '1');
    row.querySelector<HTMLButtonElement>('.edit__block-edit-toggle')!.click();
    const dedupeBtn = Array.from(row.querySelectorAll<HTMLButtonElement>('.edit__block-quicktool')).find(
      (b) => b.textContent === '重複する語を整理'
    )!;
    expect(dedupeBtn.disabled).toBe(false);
    dedupeBtn.click();
    expect(onDraftChange).toHaveBeenCalledTimes(1);
    expect(onDraftChange.mock.calls[0]![0]).toContain('#1 asthma[tiab]');
    expect(onDraftChange.mock.calls[0]![0]).not.toContain('asthma[tiab] OR asthma[tiab]');
  });

  test('MeSH が先頭でなければ「MeSH を先頭に並べ替え」が有効で、クリックで並べ替わる', () => {
    const onDraftChange = jest.fn();
    const view = createEditView({ onDraftChange });
    const container = buildContainer();
    view(container, { state: stateReadyChips, navigate: jest.fn() }); // 'asthma[tiab] OR "Asthma"[Mesh]'
    const row = blockRow(container, '1');
    row.querySelector<HTMLButtonElement>('.edit__block-edit-toggle')!.click();
    const sortBtn = Array.from(row.querySelectorAll<HTMLButtonElement>('.edit__block-quicktool')).find(
      (b) => b.textContent === 'MeSH を先頭に並べ替え'
    )!;
    expect(sortBtn.disabled).toBe(false);
    sortBtn.click();
    expect(onDraftChange).toHaveBeenCalledTimes(1);
    expect(onDraftChange.mock.calls[0]![0]).toContain('#1 "Asthma"[Mesh] OR asthma[tiab]');
  });

  test('MeSH が既に先頭なら「MeSH を先頭に並べ替え」は disabled', () => {
    const view = createEditView();
    const container = buildContainer();
    const md = [
      '## PubMed/MEDLINE',
      '',
      '```',
      '#1 "Asthma"[Mesh] OR asthma[tiab]',
      '```',
      '',
    ].join('\n');
    view(container, { state: { ...stateReady, currentFormulaMarkdown: md }, navigate: jest.fn() });
    const row = blockRow(container, '1');
    row.querySelector<HTMLButtonElement>('.edit__block-edit-toggle')!.click();
    const sortBtn = Array.from(row.querySelectorAll<HTMLButtonElement>('.edit__block-quicktool')).find(
      (b) => b.textContent === 'MeSH を先頭に並べ替え'
    )!;
    expect(sortBtn.disabled).toBe(true);
  });
});

describe('createEditView - 詳細編集（生テキスト）はチップと併存する（issue #58 chunk 3b）', () => {
  test('鉛筆を開くと「詳細編集（生テキスト）」がチップと同時に（折りたたまず）表示される', () => {
    // 追加の開閉操作を挟まないのは、issue #42 の実操作 E2E 回帰確認
    // （tests/e2e/journey-edit-save.spec.ts）が鉛筆クリック直後に .edit__block-edit-input へ
    // 直接 fill() する前提のため（renderEditPanel の doc コメント参照）。
    const view = createEditView();
    const container = buildContainer();
    view(container, { state: stateReadyChips, navigate: jest.fn() });
    const row = blockRow(container, '1');
    row.querySelector<HTMLButtonElement>('.edit__block-edit-toggle')!.click();
    expect(row.querySelector('.edit__block-rawedit')).toBeTruthy();
    expect(row.querySelector('.edit__block-edit-input')).toBeTruthy();
    expect(row.querySelector('.edit__block-chips')).toBeTruthy();
  });

  test('詳細編集で保存すると、再構築後のチップにも反映され、鉛筆編集面は開いたままになる（フォールバック経路）', () => {
    // onDraftChange 未指定＝フォールバックのローカル rerenderBlocks を使う。onDraftChange を
    // 渡すと（bootstrap 配線と違い）ただの jest.fn() は再描画を誘発しないため、ここでは
    // フォールバック経路で「setMd 後に本当に DOM が作り直されるか」を検証する。
    const view = createEditView();
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    const row = blockRow(container, '1');
    row.querySelector<HTMLButtonElement>('.edit__block-edit-toggle')!.click();
    const input = row.querySelector<HTMLTextAreaElement>('.edit__block-edit-input')!;
    input.value = 'asthma[tiab] OR wheeze[tiab]';
    row.querySelector<HTMLButtonElement>('.edit__block-edit-save')!.click();
    const newRow = blockRow(container, '1');
    // 鉛筆編集面（チップ）が閉じずに開いたまま、新しい内容で再構築されている
    expect(newRow.querySelectorAll('.edit__chip')).toHaveLength(2);
    expect(newRow.querySelector('.edit__block-current')?.getAttribute('style')).toContain('none');
  });
});

describe('createEditView - AI 改善提案は句単位で色分けされる（issue #58 chunk 3b）', () => {
  test('削除された句に formula-diff__term--removed、追加された句に --added が付く', () => {
    const view = createEditView({ onImproveBlock: jest.fn() });
    const container = buildContainer();
    view(container, {
      state: {
        ...stateReadyFull,
        blockImprovement: {
          formulaVersionId: 'v1',
          blockId: '1',
          status: 'ready',
          result: {
            blockId: '1',
            currentExpression: 'asthma[tiab]',
            proposedExpression: '"Asthma"[Mesh] OR asthma[tiab]',
            rationale: 'MeSH 追加',
          },
          error: null,
        },
      },
      navigate: jest.fn(),
    });
    const row = blockRow(container, '1');
    // 'asthma[tiab]' は before/after 両方にあるので same、'"Asthma"[Mesh]' は after にしか無いので added
    expect(row.querySelector('.edit__block-diff-before .formula-diff__term--same')).toBeTruthy();
    expect(row.querySelector('.edit__block-diff-after .formula-diff__term--added')).toBeTruthy();
    expect(row.querySelector('.edit__block-diff-before .formula-diff__term--removed')).toBeNull();
    // textContent は元の式と一致する（色分けで内容が変わらないことの確認）
    expect(row.querySelector('.edit__block-diff-before pre')?.textContent).toBe('asthma[tiab]');
    expect(row.querySelector('.edit__block-diff-after pre')?.textContent).toBe(
      '"Asthma"[Mesh] OR asthma[tiab]'
    );
  });
});

describe('createEditView - ブロック・インスペクタから式を変更できる（onApplyExpression 配線。issue #58 chunk 3b）', () => {
  test('Δ 表の × 削除で onDraftChange が更新後の md で呼ばれる', async () => {
    const onCountHits = jest.fn((q: string) => {
      if (q === 'surgeon*[tiab]') return Promise.resolve(300);
      if (q === 'neurosurgeon*[tiab]') return Promise.resolve(15);
      return Promise.resolve(310);
    });
    const onDraftChange = jest.fn();
    const view = createEditView({ onCountHits, onDraftChange });
    const container = buildContainer();
    const md = [
      '## PubMed/MEDLINE',
      '',
      '```',
      '#1 surgeon*[tiab] OR neurosurgeon*[tiab]',
      '```',
      '',
    ].join('\n');
    view(container, { state: { ...stateReady, currentFormulaMarkdown: md }, navigate: jest.fn() });
    blockRow(container, '1').querySelector<HTMLButtonElement>('.edit__block-edit-toggle')!.click();
    await flushAsync();
    await flushAsync();
    // Δ 表は個別ヒット数の降順（surgeon* 300 → neurosurgeon* 15）なので、最初の × は surgeon* の行。
    const removeBtn = blockRow(container, '1').querySelector<HTMLButtonElement>(
      '.bins__delta-remove'
    )!;
    removeBtn.click();
    expect(onDraftChange).toHaveBeenCalledTimes(1);
    expect(onDraftChange.mock.calls[0]![0]).toContain('#1 neurosurgeon*[tiab]');
  });
});

describe('createEditView - AI 改善へインスペクタの計測済みヒット数を渡す（issue #58 chunk 3c）', () => {
  test('インスペクタが計測済みなら、submit で onImproveBlock に keywordHits / freewordDedupTotal が載る', async () => {
    const onCountHits = jest.fn((q: string) => {
      if (q === 'surgeon*[tiab]') return Promise.resolve(300);
      if (q === 'neurosurgeon*[tiab]') return Promise.resolve(15);
      return Promise.resolve(310);
    });
    const onImproveBlock = jest.fn().mockResolvedValue(undefined);
    const view = createEditView({ onCountHits, onImproveBlock });
    const container = buildContainer();
    const md = [
      '## PubMed/MEDLINE',
      '',
      '```',
      '#1 surgeon*[tiab] OR neurosurgeon*[tiab]',
      '```',
      '',
    ].join('\n');
    view(container, { state: { ...stateReady, currentFormulaMarkdown: md }, navigate: jest.fn() });
    // 「AI に改善させる」を開くとインスペクタも展開し、フリーワード Δ の計測が走る。
    blockRow(container, '1').querySelector<HTMLButtonElement>('.edit__block-improve')!.click();
    await flushAsync();
    await flushAsync();
    const row = blockRow(container, '1');
    row.querySelector<HTMLTextAreaElement>('.edit__block-ai-instruction')!.value = '見直して';
    row.querySelector<HTMLButtonElement>('.edit__block-ai-submit')!.click();
    expect(onImproveBlock).toHaveBeenCalledWith({
      blockId: '1',
      instruction: '見直して',
      keywordHits: [
        { term: 'surgeon*[tiab]', kind: 'freeword', hits: 300, delta: 300, status: 'normal' },
        { term: 'neurosurgeon*[tiab]', kind: 'freeword', hits: 15, delta: 10, status: 'normal' },
      ],
      freewordDedupTotal: 310,
    });
  });

  test('インスペクタ未展開（onCountHits 未指定）なら計測値は載らない（回帰: 既存契約を壊さない）', () => {
    const onImproveBlock = jest.fn().mockResolvedValue(undefined);
    const view = createEditView({ onImproveBlock });
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    const row = blockRow(container, '1');
    row.querySelector<HTMLButtonElement>('.edit__block-improve')!.click();
    row.querySelector<HTMLTextAreaElement>('.edit__block-ai-instruction')!.value = '見直して';
    row.querySelector<HTMLButtonElement>('.edit__block-ai-submit')!.click();
    expect(onImproveBlock).toHaveBeenCalledWith({ blockId: '1', instruction: '見直して' });
    const call = onImproveBlock.mock.calls[0]![0] as Record<string, unknown>;
    expect('keywordHits' in call).toBe(false);
    expect('freewordDedupTotal' in call).toBe(false);
  });

  test('計測が未解決（Δ 計算がまだ完了していない）うちに submit すると計測値は載らない', () => {
    const onCountHits = jest.fn().mockReturnValue(new Promise<number>(() => undefined));
    const onImproveBlock = jest.fn().mockResolvedValue(undefined);
    const view = createEditView({ onCountHits, onImproveBlock });
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() }); // block '1' = 'x'（フリーワード）
    const row = blockRow(container, '1');
    row.querySelector<HTMLButtonElement>('.edit__block-improve')!.click();
    // await flushAsync() を挟まず、Δ 計算が pending のうちに送信する。
    row.querySelector<HTMLTextAreaElement>('.edit__block-ai-instruction')!.value = '見直して';
    row.querySelector<HTMLButtonElement>('.edit__block-ai-submit')!.click();
    expect(onImproveBlock).toHaveBeenCalledWith({ blockId: '1', instruction: '見直して' });
  });
});
