import { evaluateGuards } from './guards';
import { INITIAL_STATE, type AppState } from './store';

function buildState(overrides: Partial<AppState>): AppState {
  return { ...INITIAL_STATE, ...overrides };
}

const project = { projectId: 'p', spreadsheetId: 's', driveFolderId: 'd', title: 'T' };
const draftBlocks = {
  blocks: [{ blockLabel: 'P', description: 'p', aiGenerated: true, note: '' }],
  combinationExpression: '#1',
};
const protocolDraft: AppState['protocolDraft'] = {
  frameworkType: 'pico',
  researchQuestion: 'RQ',
  inclusionCriteria: '',
  exclusionCriteria: '',
  studyDesign: 'RCT',
  sourceType: 'manual',
  sourceFilename: null,
  rawTextRef: null,
  rawTextPreview: 'p',
  rawTextInline: '本文',
};

describe('evaluateGuards', () => {
  test('project 未選択時: home / protocol は enabled、他は全て「プロジェクトを選択」', () => {
    const g = evaluateGuards(buildState({}));
    expect(g.home.enabled).toBe(true);
    expect(g.protocol.enabled).toBe(true);
    expect(g.protocol.reason).toBe('');
    for (const route of [
      'blocks',
      'seeds',
      'draft',
      'expand',
      'edit',
      'export',
      'done',
      'history',
    ] as const) {
      expect(g[route].enabled).toBe(false);
      expect(g[route].reason).toContain('プロジェクト');
    }
  });

  test('project のみ: protocol / seeds / history 可。blocks 以降はまだ不可', () => {
    const g = evaluateGuards(buildState({ project }));
    expect(g.home.enabled).toBe(true);
    expect(g.protocol.enabled).toBe(true);
    expect(g.seeds.enabled).toBe(true);
    expect(g.history.enabled).toBe(true);
    expect(g.blocks.enabled).toBe(false);
    expect(g.blocks.reason).toContain('プロトコル');
    expect(g.draft.enabled).toBe(false);
    expect(g.draft.reason).toContain('ブロック');
    for (const route of ['expand', 'edit', 'export', 'done'] as const) {
      expect(g[route].enabled).toBe(false);
      expect(g[route].reason).toContain('検索式');
    }
  });

  test('protocolDraft あり: blocks が開く', () => {
    const g = evaluateGuards(buildState({ project, protocolDraft }));
    expect(g.blocks.enabled).toBe(true);
    expect(g.draft.enabled).toBe(false);
    expect(g.draft.reason).toContain('ブロック');
  });

  test('ブロック承認済み（currentProtocolVersion + blocks あり）: draft が開く', () => {
    const g = evaluateGuards(
      buildState({
        project,
        protocolDraft,
        blocksDraft: draftBlocks,
        currentProtocolVersion: 1,
      })
    );
    expect(g.draft.enabled).toBe(true);
    expect(g.expand.enabled).toBe(false);
    expect(g.expand.reason).toContain('検索式');
  });

  test('currentProtocolVersion があっても blocks 0 件なら draft は閉じたまま', () => {
    const g = evaluateGuards(
      buildState({
        project,
        protocolDraft,
        blocksDraft: { blocks: [], combinationExpression: '#1' },
        currentProtocolVersion: 1,
      })
    );
    expect(g.draft.enabled).toBe(false);
    expect(g.draft.reason).toContain('ブロック');
  });

  test('blocksDraft が null のままでも draft は閉じたまま', () => {
    const g = evaluateGuards(
      buildState({
        project,
        protocolDraft,
        currentProtocolVersion: 1,
        blocksDraft: null,
      })
    );
    expect(g.draft.enabled).toBe(false);
  });

  test('currentFormulaVersionId あり: expand / edit / export / done が全て開く', () => {
    const g = evaluateGuards(
      buildState({
        project,
        protocolDraft,
        blocksDraft: draftBlocks,
        currentProtocolVersion: 1,
        currentFormulaVersionId: 'v-1',
        currentFormulaMarkdown: '## PubMed/MEDLINE\n\n```\n#1 x\n```\n',
      })
    );
    for (const route of ['expand', 'edit', 'export', 'done'] as const) {
      expect(g[route].enabled).toBe(true);
      expect(g[route].reason).toBe('');
    }
  });
});

describe('自動調整から渡した編集下書きのガード', () => {
  const markdown = '## PubMed/MEDLINE\n\n```\n#1 x\n```\n';

  test('保存版がなく null 向けの下書きがあれば edit だけを許可する', () => {
    const g = evaluateGuards(buildState({
      project,
      currentFormulaVersionId: null,
      formulaEditDraft: { formulaVersionId: null, markdown },
    }));
    expect(g.edit).toEqual({ enabled: true, reason: '' });
    for (const route of ['expand', 'export', 'done'] as const) {
      expect(g[route]).toEqual({ enabled: false, reason: '先に検索式を生成または読み込んでください' });
    }
  });

  test('保存版も下書きもなければ従来どおり edit を拒否する', () => {
    const g = evaluateGuards(buildState({ project, currentFormulaVersionId: null, formulaEditDraft: null }));
    expect(g.edit).toEqual({ enabled: false, reason: '先に検索式を生成または読み込んでください' });
  });

  test.each([null, 'current-version'])('別版向けの下書きなら保存版の有無で判定する（現在の版: %s）', (currentFormulaVersionId) => {
    const g = evaluateGuards(buildState({
      project,
      currentFormulaVersionId,
      formulaEditDraft: { formulaVersionId: 'other-version', markdown },
    }));
    expect(g.edit).toEqual(currentFormulaVersionId === null
      ? { enabled: false, reason: '先に検索式を生成または読み込んでください' }
      : { enabled: true, reason: '' });
  });

  test('null 向けの下書きがあってもプロジェクト未選択なら edit を拒否する', () => {
    const g = evaluateGuards(buildState({
      project: null,
      currentFormulaVersionId: null,
      formulaEditDraft: { formulaVersionId: null, markdown },
    }));
    expect(g.edit).toEqual({ enabled: false, reason: 'プロジェクトを選択してください' });
  });
});
