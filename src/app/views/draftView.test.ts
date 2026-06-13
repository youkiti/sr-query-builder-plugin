import { INITIAL_STATE, type AppState, type BlocksDraft, type DraftRunState } from '../store';
import { createDraftView, currentStepIndex, formatDraftProgress } from './draftView';
import type { DraftProgress, ValidationSummary } from '@/app/services';

function validationSummary(): ValidationSummary {
  return {
    lineHits: [
      { blockId: '1', expression: 'a', expandedQuery: 'a', hitCount: 1200, error: null },
      { blockId: '2', expression: 'b', expandedQuery: 'b', hitCount: 800, error: null },
    ],
    finalQuery: {
      finalQuery: '(a) AND (b)',
      totalHits: 100,
      captureRate: 0,
      capturedPmids: [],
      missedPmids: ['444'],
    },
    finalQueryError: null,
    mesh: [],
    meshFrequency: [{ descriptor: 'Acute Lung Injury', count: 1 }],
    meshError: null,
    meshHierarchy: [],
    meshMermaid: 'flowchart TD',
    meshHierarchyError: null,
    eligibleSeedCount: 1,
    totalSeedCount: 1,
    loggedValidationIds: ['v'],
  };
}

function buildContainer(): HTMLElement {
  const doc = document.implementation.createHTMLDocument('test');
  const div = doc.createElement('div');
  doc.body.appendChild(div);
  return div;
}

function blocksDraft(): BlocksDraft {
  return {
    blocks: [{ blockLabel: 'P', description: 'p', aiGenerated: true, note: '' }],
    combinationExpression: '#1',
  };
}

function stateReady(extra: Partial<AppState> = {}): AppState {
  return {
    ...INITIAL_STATE,
    project: { projectId: 'p', spreadsheetId: 's', driveFolderId: 'd', title: 'T' },
    blocksDraft: blocksDraft(),
    ...extra,
  };
}

function runningState(progressLabel = 'MeSH を提案中（ブロック 1/2）'): DraftRunState {
  return {
    status: 'running',
    phase: 'generating',
    progressLabel,
    startedAtMs: Date.now() - 65_000,
    error: null,
    blockHits: [],
  };
}

describe('createDraftView', () => {
  test('プロジェクト未選択時は警告のみ', () => {
    const view = createDraftView();
    const container = buildContainer();
    view(container, { state: INITIAL_STATE, navigate: jest.fn() });
    expect(container.querySelector('.view__placeholder')?.textContent).toContain('プロジェクト');
    expect(container.querySelector('button')).toBeNull();
  });

  test('blocksDraft 未設定時はブロック承認誘導', () => {
    const view = createDraftView();
    const container = buildContainer();
    view(container, {
      state: { ...INITIAL_STATE, project: stateReady().project },
      navigate: jest.fn(),
    });
    expect(container.querySelector('.view__placeholder')?.textContent).toContain('ブロック');
  });

  test('既存の markdown があればブロック単位で表示し、ボタンは「再生成」', () => {
    const view = createDraftView();
    const container = buildContainer();
    view(container, {
      state: stateReady({
        currentFormulaMarkdown: '## PubMed/MEDLINE\n\n```\n#1 x[Mesh]\n```\n',
        currentFormulaVersionId: 'v-123',
      }),
      navigate: jest.fn(),
    });
    const formula = container.querySelector('.draft__formula');
    expect(formula).not.toBeNull();
    expect(container.querySelector('.draft__block-id')?.textContent).toBe('#1');
    // MeSH 語は専用 span で色分けされる
    expect(container.querySelector('.draft__term--mesh')?.textContent).toBe('x[Mesh]');
    expect(container.querySelector('.draft__info')?.textContent).toContain('v-123');
    expect(container.querySelector('button')?.textContent).toBe('再生成して再検証する');
  });

  test('結合行は combination スタイルで描画される', () => {
    const view = createDraftView();
    const container = buildContainer();
    view(container, {
      state: stateReady({
        currentFormulaMarkdown:
          '## PubMed/MEDLINE\n\n```\n#1 a[Mesh] OR "b"[tiab]\n#2 c[Mesh]\n#3 #1 AND #2\n```\n',
      }),
      navigate: jest.fn(),
    });
    const blocks = container.querySelectorAll('.draft__block');
    expect(blocks).toHaveLength(3);
    expect(container.querySelectorAll('.draft__block--combination')).toHaveLength(1);
    // フリーワード語も色分けされる
    expect(container.querySelector('.draft__term--freeword')?.textContent).toBe('"b"[tiab]');
  });

  test('パース不能な markdown は生テキストの pre にフォールバック', () => {
    const view = createDraftView();
    const container = buildContainer();
    view(container, {
      state: stateReady({ currentFormulaMarkdown: 'これは検索式ではない' }),
      navigate: jest.fn(),
    });
    expect(container.querySelector('pre.draft__formula--raw')?.textContent).toContain(
      'これは検索式ではない'
    );
  });

  test('markdown が無ければボタンは「生成する」', () => {
    const view = createDraftView();
    const container = buildContainer();
    view(container, { state: stateReady(), navigate: jest.fn() });
    expect(container.querySelector('button')?.textContent).toBe('生成して検証する');
    expect(container.querySelector('.draft__formula')).toBeNull();
  });

  test('現在 version が null のときは "(未保存)" を表示', () => {
    const view = createDraftView();
    const container = buildContainer();
    view(container, {
      state: stateReady({ currentFormulaMarkdown: '## PubMed\n\n```\n#1 x\n```' }),
      navigate: jest.fn(),
    });
    expect(container.querySelector('.draft__info')?.textContent).toContain('(未保存)');
  });

  test('生成クリックで onGenerate が呼ばれる', () => {
    const onGenerate = jest.fn().mockResolvedValue(undefined);
    const view = createDraftView({ onGenerate });
    const container = buildContainer();
    view(container, { state: stateReady(), navigate: jest.fn() });
    container.querySelector('button')!.click();
    expect(onGenerate).toHaveBeenCalledTimes(1);
  });

  test('クリック直後はボタンがローカルに無効化される（再描画前の二重クリック保険）', () => {
    const onGenerate = jest.fn().mockResolvedValue(undefined);
    const view = createDraftView({ onGenerate });
    const container = buildContainer();
    view(container, { state: stateReady(), navigate: jest.fn() });
    const btn = container.querySelector('button') as HTMLButtonElement;
    btn.click();
    expect(btn.disabled).toBe(true);
    btn.click();
    expect(onGenerate).toHaveBeenCalledTimes(1);
  });

  test('draftRun=running 中はボタンが無効で「実行中…」表記、進捗と経過時間を表示', () => {
    const view = createDraftView({ onGenerate: jest.fn() });
    const container = buildContainer();
    view(container, { state: stateReady({ draftRun: runningState() }), navigate: jest.fn() });
    const btn = container.querySelector('button') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toBe('実行中…');
    const statusText = container.querySelector('.draft__status')?.textContent ?? '';
    expect(statusText).toContain('MeSH を提案中（ブロック 1/2）');
    expect(statusText).toMatch(/経過 1分\d+秒/);
  });

  test('running 中はクリックしても onGenerate を呼ばない', () => {
    const onGenerate = jest.fn();
    const view = createDraftView({ onGenerate });
    const container = buildContainer();
    view(container, { state: stateReady({ draftRun: runningState() }), navigate: jest.fn() });
    container.querySelector('button')!.click();
    expect(onGenerate).not.toHaveBeenCalled();
  });

  test('経過 60 秒未満は「N秒」表記', () => {
    const view = createDraftView();
    const container = buildContainer();
    view(container, {
      state: stateReady({
        draftRun: {
          status: 'running',
          phase: 'generating',
          progressLabel: '開始します…',
          startedAtMs: Date.now() - 5_000,
          error: null,
          blockHits: [],
        },
      }),
      navigate: jest.fn(),
    });
    expect(container.querySelector('.draft__status')?.textContent).toMatch(/経過 \d秒/);
  });

  test('draftRun=error はエラーボックスに表示し、ボタンは再度押せる', () => {
    const onGenerate = jest.fn().mockResolvedValue(undefined);
    const view = createDraftView({ onGenerate });
    const container = buildContainer();
    view(container, {
      state: stateReady({
        draftRun: {
          status: 'error',
          phase: 'generating',
          progressLabel: '',
          startedAtMs: Date.now(),
          error: 'Gemini API failed: HTTP 503',
          blockHits: [],
        },
      }),
      navigate: jest.fn(),
    });
    const errorText = container.querySelector('.draft__error')?.textContent ?? '';
    expect(errorText).toContain('生成に失敗しました');
    expect(errorText).toContain('HTTP 503');
    const btn = container.querySelector('button') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    btn.click();
    expect(onGenerate).toHaveBeenCalledTimes(1);
  });

  test('draftRun=error で error が null でも文言を出す', () => {
    const view = createDraftView();
    const container = buildContainer();
    view(container, {
      state: stateReady({
        draftRun: {
          status: 'error',
          phase: 'generating',
          progressLabel: '',
          startedAtMs: Date.now(),
          error: null,
          blockHits: [],
        },
      }),
      navigate: jest.fn(),
    });
    expect(container.querySelector('.draft__error')?.textContent).toContain('不明なエラー');
  });

  test('生成中はブロックごとのヒット数をライブ表示（計測済みは件数、未計測は「計測中…」）', () => {
    const view = createDraftView();
    const container = buildContainer();
    const draft: BlocksDraft = {
      blocks: [
        { blockLabel: 'P', description: '', aiGenerated: true, note: '' },
        { blockLabel: 'I', description: '', aiGenerated: true, note: '' },
      ],
      combinationExpression: '#1 AND #2',
    };
    view(container, {
      state: stateReady({
        blocksDraft: draft,
        draftRun: {
          status: 'running',
          phase: 'generating',
          progressLabel: 'フリーワードを展開中',
          startedAtMs: Date.now(),
          error: null,
          blockHits: [
            { blockIndex: 0, blockId: '1', blockLabel: 'P', expression: 'a', hitCount: 1234, error: null },
          ],
        },
      }),
      navigate: jest.fn(),
    });
    const items = container.querySelectorAll('.draft__block-hit');
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain('1,234 件');
    expect(items[1]?.textContent).toContain('計測中…');
  });

  test('実行中は進捗トラッカー（バー + ステップカウンタ + ステッパー）を表示する', () => {
    const view = createDraftView();
    const container = buildContainer();
    const draft: BlocksDraft = {
      blocks: [
        { blockLabel: 'Population', description: '', aiGenerated: true, note: '' },
        { blockLabel: 'Intervention', description: '', aiGenerated: true, note: '' },
      ],
      combinationExpression: '#1 AND #2',
    };
    view(container, {
      state: stateReady({
        blocksDraft: draft,
        draftRun: {
          ...runningState('フリーワードを展開中（ブロック 2/2）'),
          progress: { phase: 'generating', step: 'freeword-designer', blockIndex: 1, blockCount: 2 },
        },
      }),
      navigate: jest.fn(),
    });
    // バーと総数（生成 4×2 + 末尾 3 + 検証 5 = 16）
    const bar = container.querySelector('progress.draft__progressbar') as HTMLProgressElement;
    expect(bar).not.toBeNull();
    expect(bar.max).toBe(16);
    // freeword(ブロック2) = index 1*4 + 2 = 6 → 7 番目
    expect(bar.value).toBe(6);
    expect(container.querySelector('.draft__step-counter')?.textContent).toBe('ステップ 7 / 16');
    // ブロック #1 は完了、#2 が実行中
    const blockRows = container.querySelectorAll('.draft__step-block');
    expect(blockRows).toHaveLength(2);
    expect(blockRows[0]?.className).toContain('draft__step-block--done');
    expect(blockRows[1]?.className).toContain('draft__step-block--active');
    // #2 の骨格・MeSH は done、フリーワードが active、件数は pending
    const block2Steps = blockRows[1]?.querySelectorAll('.draft__step') ?? [];
    expect(block2Steps[0]?.className).toContain('draft__step--done');
    expect(block2Steps[1]?.className).toContain('draft__step--done');
    expect(block2Steps[2]?.className).toContain('draft__step--active');
    expect(block2Steps[3]?.className).toContain('draft__step--pending');
  });

  test('実行中でなければ進捗トラッカーは出ない', () => {
    const view = createDraftView();
    const container = buildContainer();
    view(container, { state: stateReady(), navigate: jest.fn() });
    expect(container.querySelector('.draft__tracker')).toBeNull();
  });

  test('検証結果が state にあり実行中でなければ捕捉率・未捕捉 PMID を表示する', () => {
    const view = createDraftView();
    const container = buildContainer();
    view(container, {
      state: stateReady({
        currentFormulaMarkdown: '## PubMed/MEDLINE\n\n```\n#1 x\n```\n',
        currentFormulaVersionId: 'fv-1',
        validationResult: { formulaVersionId: 'fv-1', summary: validationSummary() },
      }),
      navigate: jest.fn(),
    });
    expect(container.querySelector('.validate__line-hits')?.textContent).toContain('#1: 1200 件');
    expect(container.querySelector('.validate__final')?.textContent).toContain('全体ヒット数: 100');
    expect(container.querySelector('.validate__missed')?.textContent).toContain('444');
    expect(container.querySelector('.validate__mesh')?.textContent).toContain('Acute Lung Injury');
  });

  test('検証結果が別 version のものなら表示しない（stale 判定）', () => {
    const view = createDraftView();
    const container = buildContainer();
    view(container, {
      state: stateReady({
        currentFormulaMarkdown: '## PubMed/MEDLINE\n\n```\n#1 x\n```\n',
        currentFormulaVersionId: 'fv-2',
        validationResult: { formulaVersionId: 'fv-1', summary: validationSummary() },
      }),
      navigate: jest.fn(),
    });
    expect(container.querySelector('.validate__line-hits')).toBeNull();
  });

  test('onGenerate 未指定でもクリックで例外にならない', () => {
    const view = createDraftView();
    const container = buildContainer();
    view(container, { state: stateReady(), navigate: jest.fn() });
    expect(() => container.querySelector('button')!.click()).not.toThrow();
  });
});

describe('formatDraftProgress', () => {
  test('blockIndex 付きステップは「ブロック N/M」カウンタを出す', () => {
    expect(
      formatDraftProgress({ step: 'mesh-suggester', blockIndex: 0, blockCount: 3 })
    ).toContain('1/3');
  });

  test('blockIndex 無しステップはカウンタを出さない', () => {
    expect(formatDraftProgress({ step: 'filter-designer', blockCount: 2 })).not.toContain('/');
  });

  test('全ステップにラベルがある', () => {
    const steps: DraftProgress['step'][] = [
      'block-designer',
      'mesh-suggester',
      'freeword-designer',
      'line-hits',
      'filter-designer',
      'assemble',
      'save',
      'done',
    ];
    for (const step of steps) {
      expect(formatDraftProgress({ step, blockCount: 1 })).toBeTruthy();
    }
  });
});

describe('currentStepIndex', () => {
  // blockCount=2 のとき: 生成 4×2=8（idx 0-7）, 末尾 3（idx 8-10）, 検証 5（idx 11-15）
  test('progress 未設定なら 0', () => {
    expect(currentStepIndex(null, 2)).toBe(0);
    expect(currentStepIndex(undefined, 2)).toBe(0);
  });

  test('生成サブステップは blockIndex×4 + サブ位置', () => {
    expect(currentStepIndex({ phase: 'generating', step: 'block-designer', blockIndex: 0, blockCount: 2 }, 2)).toBe(0);
    expect(currentStepIndex({ phase: 'generating', step: 'line-hits', blockIndex: 0, blockCount: 2 }, 2)).toBe(3);
    expect(currentStepIndex({ phase: 'generating', step: 'mesh-suggester', blockIndex: 1, blockCount: 2 }, 2)).toBe(5);
  });

  test('生成末尾ステップはブロック分の後ろに並ぶ', () => {
    expect(currentStepIndex({ phase: 'generating', step: 'filter-designer', blockCount: 2 }, 2)).toBe(8);
    expect(currentStepIndex({ phase: 'generating', step: 'save', blockCount: 2 }, 2)).toBe(10);
  });

  test('生成 done は検証開始位置（=生成全完了）', () => {
    expect(currentStepIndex({ phase: 'generating', step: 'done', blockCount: 2 }, 2)).toBe(11);
  });

  test('検証ステップは生成全体の後ろに並ぶ', () => {
    expect(currentStepIndex({ phase: 'validating', step: 'line_hits' }, 2)).toBe(11);
    expect(currentStepIndex({ phase: 'validating', step: 'logging' }, 2)).toBe(15);
    expect(currentStepIndex({ phase: 'validating', step: 'done' }, 2)).toBe(16);
  });
});
