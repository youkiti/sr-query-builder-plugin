import { INITIAL_STATE, type AppState } from '../store';
import { createEditView } from './editView';

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

describe('createEditView', () => {
  test('プロジェクト未選択時は警告のみ', () => {
    const view = createEditView();
    const container = buildContainer();
    view(container, { state: INITIAL_STATE, navigate: jest.fn() });
    expect(container.querySelector('.view__placeholder')?.textContent).toContain('プロジェクト');
    expect(container.querySelector('.edit__formula')).toBeNull();
  });

  test('検索式未読込時は /draft 誘導', () => {
    const view = createEditView();
    const container = buildContainer();
    view(container, {
      state: { ...stateReady, currentFormulaMarkdown: null },
      navigate: jest.fn(),
    });
    expect(container.querySelector('.view__placeholder')?.textContent).toContain('/draft');
    expect(container.querySelector('.edit__formula')).toBeNull();
  });

  test('現在の markdown を textarea に読み込む', () => {
    const view = createEditView();
    const container = buildContainer();
    view(container, { state: stateReady, navigate: jest.fn() });
    const textarea = container.querySelector<HTMLTextAreaElement>('.edit__formula');
    expect(textarea?.value).toContain('#1 x');
  });

  test('保存ボタン押下で onSave が呼ばれ、status を更新', async () => {
    const onSave = jest
      .fn()
      .mockResolvedValue({ versionId: 'new-id', parentVersionId: 'v1' });
    const view = createEditView({ onSave });
    const container = buildContainer();
    view(container, { state: stateReady, navigate: jest.fn() });
    const textarea = container.querySelector<HTMLTextAreaElement>('.edit__formula')!;
    textarea.value = '## PubMed/MEDLINE\n\n```\n#1 new\n```\n';
    const noteInput = container.querySelector<HTMLInputElement>('.edit__note-input')!;
    noteInput.value = 'メモ';
    const saveBtn = container.querySelector<HTMLButtonElement>('.edit__actions button')!;
    saveBtn.click();
    await flushAsync();
    await flushAsync();
    expect(onSave).toHaveBeenCalledWith({
      formulaMd: '## PubMed/MEDLINE\n\n```\n#1 new\n```\n',
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
});

describe('createEditView - 行単位 AI 改善', () => {
  test('formula_md のブロックごとに improve ボタンが並ぶ', () => {
    const view = createEditView({ onImproveBlock: jest.fn() });
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    const rows = container.querySelectorAll('.edit__block-row');
    expect(rows).toHaveLength(3);
    expect(rows[0]!.querySelector('.edit__block-id')?.textContent).toBe('#1');
    expect(rows[0]!.querySelector('.edit__block-current')?.textContent).toBe('asthma[tiab]');
    expect(rows[0]!.querySelector('.edit__block-improve')).toBeTruthy();
  });

  test('AI 改善ボタンクリックで onImproveBlock が呼ばれ、diff と accept / reject が出る', async () => {
    const onImproveBlock = jest.fn().mockResolvedValue({
      blockId: '1',
      currentExpression: 'asthma[tiab]',
      proposedExpression: '"Asthma"[Mesh] OR asthma*[tiab]',
      rationale: 'MeSH 追加で感度向上',
    });
    const view = createEditView({ onImproveBlock });
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    const improveBtn = container.querySelector<HTMLButtonElement>(
      '.edit__block-row[data-block-id="1"] .edit__block-improve'
    )!;
    improveBtn.click();
    await flushAsync();
    await flushAsync();
    expect(onImproveBlock).toHaveBeenCalledWith({ blockId: '1' });
    const row = container.querySelector('.edit__block-row[data-block-id="1"]')!;
    expect(row.querySelector('.edit__block-rationale')?.textContent).toContain('MeSH 追加');
    expect(row.querySelector('.edit__block-diff-before pre')?.textContent).toBe('asthma[tiab]');
    expect(row.querySelector('.edit__block-diff-after pre')?.textContent).toBe(
      '"Asthma"[Mesh] OR asthma*[tiab]'
    );
    expect(row.querySelector('.edit__block-accept')).toBeTruthy();
    expect(row.querySelector('.edit__block-reject')).toBeTruthy();
    expect(improveBtn.disabled).toBe(false);
  });

  test('accept を押すと textarea の #1 行が置換され、feedback が出る', async () => {
    const onImproveBlock = jest.fn().mockResolvedValue({
      blockId: '1',
      currentExpression: 'asthma[tiab]',
      proposedExpression: '"Asthma"[Mesh]',
      rationale: 'r',
    });
    const view = createEditView({ onImproveBlock });
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    const row = container.querySelector('.edit__block-row[data-block-id="1"]')!;
    row.querySelector<HTMLButtonElement>('.edit__block-improve')!.click();
    await flushAsync();
    await flushAsync();
    row.querySelector<HTMLButtonElement>('.edit__block-accept')!.click();
    const textarea = container.querySelector<HTMLTextAreaElement>('.edit__formula')!;
    expect(textarea.value).toContain('#1 "Asthma"[Mesh]');
    expect(textarea.value).toContain('#2 children[tiab]');
    expect(row.querySelector('.edit__block-feedback')?.textContent).toContain('置き換え');
  });

  test('reject でスロットがクリアされる', async () => {
    const onImproveBlock = jest.fn().mockResolvedValue({
      blockId: '1',
      currentExpression: 'asthma[tiab]',
      proposedExpression: 'new',
      rationale: 'r',
    });
    const view = createEditView({ onImproveBlock });
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    const row = container.querySelector('.edit__block-row[data-block-id="1"]')!;
    row.querySelector<HTMLButtonElement>('.edit__block-improve')!.click();
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
    const row = container.querySelector('.edit__block-row[data-block-id="1"]')!;
    row.querySelector<HTMLButtonElement>('.edit__block-improve')!.click();
    await flushAsync();
    await flushAsync();
    expect(row.querySelector<HTMLButtonElement>('.edit__block-accept')!.disabled).toBe(true);
  });

  test('提案が空文字でも accept は disabled（improve 失敗時のデフォルト挙動）', async () => {
    const onImproveBlock = jest.fn().mockResolvedValue({
      blockId: '1',
      currentExpression: 'asthma[tiab]',
      proposedExpression: '',
      rationale: '',
    });
    const view = createEditView({ onImproveBlock });
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    const row = container.querySelector('.edit__block-row[data-block-id="1"]')!;
    row.querySelector<HTMLButtonElement>('.edit__block-improve')!.click();
    await flushAsync();
    await flushAsync();
    expect(row.querySelector<HTMLButtonElement>('.edit__block-accept')!.disabled).toBe(true);
    expect(row.querySelector('.edit__block-rationale')?.textContent).toContain('（改善ポイント');
  });

  test('onImproveBlock が reject したらエラーを表示して improve ボタンが再有効化', async () => {
    const onImproveBlock = jest.fn().mockRejectedValue(new Error('llm boom'));
    const view = createEditView({ onImproveBlock });
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    const row = container.querySelector('.edit__block-row[data-block-id="1"]')!;
    const improveBtn = row.querySelector<HTMLButtonElement>('.edit__block-improve')!;
    improveBtn.click();
    await flushAsync();
    await flushAsync();
    expect(row.querySelector('.edit__block-error')?.textContent).toContain('llm boom');
    expect(improveBtn.disabled).toBe(false);
  });

  test('onImproveBlock 未指定の場合はクリックしても何も起きない', () => {
    const view = createEditView();
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    const improveBtn = container.querySelector<HTMLButtonElement>(
      '.edit__block-row[data-block-id="1"] .edit__block-improve'
    )!;
    expect(() => improveBtn.click()).not.toThrow();
    expect(improveBtn.disabled).toBe(false);
  });

  test('textarea が PubMed セクションとして壊れたらパースエラーを出し、ブロック行は描画されない', () => {
    const view = createEditView({ onImproveBlock: jest.fn() });
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    const textarea = container.querySelector<HTMLTextAreaElement>('.edit__formula')!;
    textarea.value = 'not a valid formula';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    expect(container.querySelectorAll('.edit__block-row')).toHaveLength(0);
    expect(container.querySelector('.edit__block-error')?.textContent).toContain('パース');
  });

  test('ブロックが 0 件のコードブロックは「ブロックがありません」表示', () => {
    // フェンスを開閉のみにすると `parseBody('')` → blocks: [] が返る
    const empty = '## PubMed/MEDLINE\n\n```\n\n```\n';
    const view = createEditView({ onImproveBlock: jest.fn() });
    const container = buildContainer();
    view(container, {
      state: { ...stateReady, currentFormulaMarkdown: empty },
      navigate: jest.fn(),
    });
    expect(container.querySelector('.edit__block-empty')?.textContent).toContain(
      'ブロックがありません'
    );
  });

  test('accept 時に base の formula_md から #N 行が消えていると置換失敗して feedback にエラーを出す', async () => {
    // 提案取得 → 解決前にユーザーが textarea を壊す → 解決で base に壊れた md が入る → accept 失敗
    let resolveProposal: ((v: {
      blockId: string;
      currentExpression: string;
      proposedExpression: string;
      rationale: string;
    }) => void) | null = null;
    const onImproveBlock = jest.fn(
      () =>
        new Promise<{
          blockId: string;
          currentExpression: string;
          proposedExpression: string;
          rationale: string;
        }>((r) => {
          resolveProposal = r;
        })
    );
    const view = createEditView({ onImproveBlock });
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    const textarea = container.querySelector<HTMLTextAreaElement>('.edit__formula')!;
    const row = container.querySelector('.edit__block-row[data-block-id="1"]')!;
    row.querySelector<HTMLButtonElement>('.edit__block-improve')!.click();
    // 未解決のうちに textarea から #1 行を削る → 再レンダで元 row は detach
    textarea.value = '## PubMed/MEDLINE\n\n```\n#2 children[tiab]\n```\n';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    // ここで解決させる。renderProposal の base = 現在の textarea.value（#1 無し）
    resolveProposal!({
      blockId: '1',
      currentExpression: 'asthma[tiab]',
      proposedExpression: 'new',
      rationale: 'r',
    });
    await flushAsync();
    await flushAsync();
    // detach された row のクロージャに残る proposalSlot / feedback を参照する
    const acceptBtn = row.querySelector<HTMLButtonElement>('.edit__block-accept')!;
    const feedback = row.querySelector<HTMLElement>('.edit__block-feedback')!;
    acceptBtn.click();
    expect(feedback.textContent).toContain('置き換えに失敗');
  });

  test('accept 失敗ケース: 提案入手→ textarea 書換前の base を覚えているので成功、その後に再 accept 不要（無効化される）', async () => {
    // 同じブロックに対して 2 回 accept を押そうとしたら 2 回目は disabled で何も起きないことを確認
    const onImproveBlock = jest.fn().mockResolvedValue({
      blockId: '1',
      currentExpression: 'asthma[tiab]',
      proposedExpression: 'new-expr',
      rationale: 'r',
    });
    const view = createEditView({ onImproveBlock });
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    const row = container.querySelector('.edit__block-row[data-block-id="1"]')!;
    row.querySelector<HTMLButtonElement>('.edit__block-improve')!.click();
    await flushAsync();
    await flushAsync();
    const acceptBtn = row.querySelector<HTMLButtonElement>('.edit__block-accept')!;
    acceptBtn.click();
    expect(acceptBtn.disabled).toBe(true);
    // 2 回目: disabled なので何もしない
    acceptBtn.click();
  });

  test('Error 以外の例外も String 化される', async () => {
    const onImproveBlock = jest.fn().mockRejectedValue('oops');
    const view = createEditView({ onImproveBlock });
    const container = buildContainer();
    view(container, { state: stateReadyFull, navigate: jest.fn() });
    const row = container.querySelector('.edit__block-row[data-block-id="1"]')!;
    row.querySelector<HTMLButtonElement>('.edit__block-improve')!.click();
    await flushAsync();
    await flushAsync();
    expect(row.querySelector('.edit__block-error')?.textContent).toContain('oops');
  });
});
