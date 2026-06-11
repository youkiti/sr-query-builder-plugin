import type { ValidationSummary } from '@/app/services';
import { INITIAL_STATE, type AppState } from '../store';
import { createValidateView } from './validateView';

function buildContainer(): HTMLElement {
  const doc = document.implementation.createHTMLDocument('test');
  const div = doc.createElement('div');
  doc.body.appendChild(div);
  return div;
}

function stateReady(extra: Partial<AppState> = {}): AppState {
  return {
    ...INITIAL_STATE,
    project: { projectId: 'p', spreadsheetId: 's', driveFolderId: 'd', title: 'T' },
    currentFormulaVersionId: 'v-1',
    currentFormulaMarkdown: '## PubMed/MEDLINE\n\n```\n#1 x\n```\n',
    ...extra,
  };
}

function sampleSummary(overrides: Partial<ValidationSummary> = {}): ValidationSummary {
  return {
    lineHits: [
      { blockId: '1', expression: 'diabetes', expandedQuery: 'diabetes', hitCount: 100, error: null },
      { blockId: '2', expression: 'metformin', expandedQuery: 'metformin', hitCount: 200, error: null },
      {
        blockId: '3',
        expression: '#1 AND #2',
        expandedQuery: '(diabetes) AND (metformin)',
        hitCount: 0,
        error: 'network',
      },
    ],
    finalQuery: {
      finalQuery: '(diabetes) AND (metformin)',
      totalHits: 500,
      captureRate: 0.75,
      capturedPmids: ['111', '222', '333'],
      missedPmids: ['444'],
    },
    finalQueryError: null,
    mesh: [
      { pmid: '111', title: 'A', meshHeadings: ['Diabetes Mellitus'] },
    ],
    meshFrequency: [
      { descriptor: 'Diabetes Mellitus', count: 2 },
      { descriptor: 'Metformin', count: 1 },
    ],
    meshError: null,
    meshHierarchy: [
      { treeId: 'C', parentId: null, labels: [] },
      { treeId: 'C18', parentId: 'C', labels: [] },
      { treeId: 'C18.452.394', parentId: 'C18', labels: ['Diabetes Mellitus'] },
    ],
    meshMermaid: 'flowchart TD\n  C["C"]\n  C18["C18"]\n  C18_452_394["C18.452.394<br/>Diabetes Mellitus"]\n  C --> C18\n  C18 --> C18_452_394',
    meshHierarchyError: null,
    eligibleSeedCount: 4,
    totalSeedCount: 5,
    loggedValidationIds: ['v1', 'v2', 'v3', 'v4', 'v5'],
    ...overrides,
  };
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('createValidateView', () => {
  test('プロジェクト未選択時は警告のみ', () => {
    const view = createValidateView();
    const container = buildContainer();
    view(container, { state: INITIAL_STATE, navigate: jest.fn() });
    expect(container.querySelector('.view__placeholder')?.textContent).toContain('プロジェクト');
  });

  test('formula が無ければ draft 誘導', () => {
    const view = createValidateView();
    const container = buildContainer();
    view(container, {
      state: { ...INITIAL_STATE, project: stateReady().project },
      navigate: jest.fn(),
    });
    expect(container.querySelector('.view__placeholder')?.textContent).toContain('/draft');
  });

  test('検証ボタンで onRun が呼ばれ、結果が描画される', async () => {
    const onRun = jest.fn().mockResolvedValue(sampleSummary());
    const view = createValidateView({ onRun });
    const container = buildContainer();
    view(container, { state: stateReady(), navigate: jest.fn() });
    container.querySelector('button')!.click();
    await flushAsync();
    await flushAsync();
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.validate__status')?.textContent).toContain('4/5');
    expect(container.querySelectorAll('.validate__line-hits li')).toHaveLength(3);
    expect(container.querySelector('.validate__line-error')?.textContent).toContain('network');
    expect(container.querySelector('.validate__final p')?.textContent).toContain('500');
    expect(container.querySelector('.validate__final')?.textContent).toContain('75.0%');
    expect(container.querySelectorAll('.validate__missed li')).toHaveLength(2); // "未捕捉 PMID:" + 444
    expect(container.querySelectorAll('.validate__mesh li')).toHaveLength(2);
    const mermaid = container.querySelector('.validate__mesh-mermaid');
    expect(mermaid?.textContent).toContain('flowchart TD');
    expect(mermaid?.className).toContain('mermaid');
    expect(container.querySelector('.validate__mesh-hierarchy-note')?.textContent).toContain(
      'mermaid.live'
    );
  });

  test('mesh 階層取得失敗時は meshHierarchy エラーセクションに理由を出し、frequency は残す', async () => {
    const onRun = jest.fn().mockResolvedValue(
      sampleSummary({
        meshHierarchy: [],
        meshMermaid: 'flowchart TD\n  empty["(MeSH 階層なし)"]',
        meshHierarchyError: 'mesh tree down',
      })
    );
    const view = createValidateView({ onRun });
    const container = buildContainer();
    view(container, { state: stateReady(), navigate: jest.fn() });
    container.querySelector('button')!.click();
    await flushAsync();
    await flushAsync();
    // 頻度リストは 2 件のまま
    expect(container.querySelectorAll('.validate__mesh li')).toHaveLength(2);
    expect(container.querySelector('.validate__mesh-hierarchy-error')?.textContent).toContain(
      'mesh tree down'
    );
    expect(container.querySelector('.validate__mesh-mermaid')).toBeNull();
  });

  test('meshHierarchy が空かつエラー無しなら「階層情報が取得できませんでした」を出す', async () => {
    const onRun = jest.fn().mockResolvedValue(
      sampleSummary({
        meshHierarchy: [],
        meshMermaid: 'flowchart TD\n  empty["(MeSH 階層なし)"]',
        meshHierarchyError: null,
      })
    );
    const view = createValidateView({ onRun });
    const container = buildContainer();
    view(container, { state: stateReady(), navigate: jest.fn() });
    container.querySelector('button')!.click();
    await flushAsync();
    await flushAsync();
    expect(container.querySelector('.validate__mesh-hierarchy')?.textContent).toContain(
      '階層情報が取得できませんでした'
    );
    expect(container.querySelector('.validate__mesh-mermaid')).toBeNull();
  });

  test('final_query / mesh の部分失敗は各セクションに表示する', async () => {
    const onRun = jest.fn().mockResolvedValue(
      sampleSummary({
        finalQueryError: 'final down',
        meshError: 'mesh down',
        meshFrequency: [],
      })
    );
    const view = createValidateView({ onRun });
    const container = buildContainer();
    view(container, { state: stateReady(), navigate: jest.fn() });
    container.querySelector('button')!.click();
    await flushAsync();
    await flushAsync();
    expect(container.querySelector('.validate__final-error')?.textContent).toContain('final down');
    expect(container.querySelector('.validate__mesh-error')?.textContent).toContain('mesh down');
  });

  test('seed が 0 件なら捕捉率は「計算不能」表示', async () => {
    const onRun = jest.fn().mockResolvedValue(
      sampleSummary({
        finalQuery: {
          finalQuery: 'x',
          totalHits: 100,
          captureRate: 0,
          capturedPmids: [],
          missedPmids: [],
        },
        meshFrequency: [],
        eligibleSeedCount: 0,
        totalSeedCount: 0,
      })
    );
    const view = createValidateView({ onRun });
    const container = buildContainer();
    view(container, { state: stateReady(), navigate: jest.fn() });
    container.querySelector('button')!.click();
    await flushAsync();
    await flushAsync();
    expect(container.querySelector('.validate__final')?.textContent).toContain('計算不能');
    expect(container.querySelectorAll('.validate__missed')).toHaveLength(0);
    expect(container.querySelector('.validate__mesh')?.textContent).toContain('集計できません');
  });

  test('未捕捉 PMID があると「AI で原因を分析する」ボタンを出し、結果を描画する', async () => {
    const onRun = jest.fn().mockResolvedValue(sampleSummary());
    const onAnalyzeMissed = jest.fn().mockResolvedValue({
      analyses: [
        {
          pmid: '444',
          cause: 'acute lung injury が #1 に無いため取りこぼしています。',
          suggestedTerms: ['"acute lung injury"[tiab]'],
          relatedBlock: '1',
        },
      ],
      fetchedPmids: ['444'],
    });
    const view = createValidateView({ onRun, onAnalyzeMissed });
    const container = buildContainer();
    view(container, { state: stateReady(), navigate: jest.fn() });
    container.querySelector('button')!.click();
    await flushAsync();
    await flushAsync();

    const analyzeBtn = container.querySelector<HTMLButtonElement>('.validate__analyze-missed');
    expect(analyzeBtn).not.toBeNull();
    analyzeBtn!.click();
    await flushAsync();
    await flushAsync();

    expect(onAnalyzeMissed).toHaveBeenCalledWith(['444']);
    const items = container.querySelectorAll('.validate__analysis-item');
    expect(items).toHaveLength(1);
    expect(items[0]!.textContent).toContain('PMID 444');
    expect(items[0]!.textContent).toContain('推定ブロック: #1');
    expect(items[0]!.textContent).toContain('acute lung injury');
    expect(container.querySelector('.validate__analysis-terms li')?.textContent).toContain(
      'acute lung injury'
    );
    expect(container.querySelector('.validate__analyze-status')?.textContent).toContain(
      '1 件'
    );
  });

  test('未捕捉 PMID が無いと分析ボタンを出さない', async () => {
    const onRun = jest.fn().mockResolvedValue(
      sampleSummary({
        finalQuery: {
          finalQuery: 'x',
          totalHits: 100,
          captureRate: 1,
          capturedPmids: ['111', '222'],
          missedPmids: [],
        },
      })
    );
    const onAnalyzeMissed = jest.fn();
    const view = createValidateView({ onRun, onAnalyzeMissed });
    const container = buildContainer();
    view(container, { state: stateReady(), navigate: jest.fn() });
    container.querySelector('button')!.click();
    await flushAsync();
    await flushAsync();
    expect(container.querySelector('.validate__analyze-missed')).toBeNull();
  });

  test('分析が空結果なら status に「得られませんでした」', async () => {
    const onRun = jest.fn().mockResolvedValue(sampleSummary());
    const onAnalyzeMissed = jest
      .fn()
      .mockResolvedValue({ analyses: [], fetchedPmids: [] });
    const view = createValidateView({ onRun, onAnalyzeMissed });
    const container = buildContainer();
    view(container, { state: stateReady(), navigate: jest.fn() });
    container.querySelector('button')!.click();
    await flushAsync();
    await flushAsync();
    container.querySelector<HTMLButtonElement>('.validate__analyze-missed')!.click();
    await flushAsync();
    await flushAsync();
    expect(container.querySelector('.validate__analyze-status')?.textContent).toContain(
      '得られませんでした'
    );
  });

  test('分析が reject したらエラー表示し status をクリア', async () => {
    const onRun = jest.fn().mockResolvedValue(sampleSummary());
    const onAnalyzeMissed = jest.fn().mockRejectedValue(new Error('鍵が未設定'));
    const view = createValidateView({ onRun, onAnalyzeMissed });
    const container = buildContainer();
    view(container, { state: stateReady(), navigate: jest.fn() });
    container.querySelector('button')!.click();
    await flushAsync();
    await flushAsync();
    container.querySelector<HTMLButtonElement>('.validate__analyze-missed')!.click();
    await flushAsync();
    await flushAsync();
    expect(container.querySelector('.validate__analyze-error')?.textContent).toBe('鍵が未設定');
    expect(container.querySelector('.validate__analyze-status')?.textContent).toBe('');
  });

  test('onAnalyzeMissed 未指定でも分析ボタンのクリックで例外にならない', async () => {
    const onRun = jest.fn().mockResolvedValue(sampleSummary());
    const view = createValidateView({ onRun });
    const container = buildContainer();
    view(container, { state: stateReady(), navigate: jest.fn() });
    container.querySelector('button')!.click();
    await flushAsync();
    await flushAsync();
    const analyzeBtn = container.querySelector<HTMLButtonElement>('.validate__analyze-missed');
    expect(analyzeBtn).not.toBeNull();
    expect(() => analyzeBtn!.click()).not.toThrow();
  });

  test('onRun が reject したらエラー表示', async () => {
    const onRun = jest.fn().mockRejectedValue(new Error('boom'));
    const view = createValidateView({ onRun });
    const container = buildContainer();
    view(container, { state: stateReady(), navigate: jest.fn() });
    container.querySelector('button')!.click();
    await flushAsync();
    await flushAsync();
    expect(container.querySelector('.validate__error')?.textContent).toBe('boom');
  });

  test('Error 以外の例外も String 化', async () => {
    const onRun = jest.fn().mockRejectedValue('rare');
    const view = createValidateView({ onRun });
    const container = buildContainer();
    view(container, { state: stateReady(), navigate: jest.fn() });
    container.querySelector('button')!.click();
    await flushAsync();
    await flushAsync();
    expect(container.querySelector('.validate__error')?.textContent).toBe('rare');
  });

  test('onRun 未指定でもクリックで例外にならない', () => {
    const view = createValidateView();
    const container = buildContainer();
    view(container, { state: stateReady(), navigate: jest.fn() });
    expect(() => container.querySelector('button')!.click()).not.toThrow();
  });
});
