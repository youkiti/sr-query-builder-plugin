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
    mesh: [
      { pmid: '111', title: 'A', meshHeadings: ['Diabetes Mellitus'] },
    ],
    meshFrequency: [
      { descriptor: 'Diabetes Mellitus', count: 2 },
      { descriptor: 'Metformin', count: 1 },
    ],
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
