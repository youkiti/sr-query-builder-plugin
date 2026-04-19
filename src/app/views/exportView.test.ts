import type { ExportResult } from '@/app/services';
import { INITIAL_STATE, type AppState } from '../store';
import { createExportView } from './exportView';

function buildContainer(): HTMLElement {
  const doc = document.implementation.createHTMLDocument('test');
  const div = doc.createElement('div');
  doc.body.appendChild(div);
  return div;
}

function stateWithDraft(extra: Partial<AppState> = {}): AppState {
  return {
    ...INITIAL_STATE,
    project: { projectId: 'p', spreadsheetId: 's', driveFolderId: 'd', title: 'T' },
    currentFormulaVersionId: 'v-1',
    currentFormulaMarkdown:
      '## PubMed/MEDLINE\n\n```\n#1 "Diabetes"[Mesh]\n#2 #1 AND metformin\n```\n',
    ...extra,
  };
}

function sampleResult(): ExportResult {
  return {
    conversions: [
      {
        targetDb: 'central',
        convertedFormula: '#1 [mh "Diabetes"]\n#2 #1 AND metformin',
        warnings: [],
      },
      {
        targetDb: 'clinicaltrials',
        convertedFormula: '#1 "Diabetes"\n#2 #1 AND metformin',
        warnings: ['Condition/Intervention 振り分け未対応'],
      },
    ],
    entries: [],
  };
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('createExportView', () => {
  test('プロジェクト未選択時は警告のみ', () => {
    const view = createExportView();
    const container = buildContainer();
    view(container, { state: INITIAL_STATE, navigate: jest.fn() });
    expect(container.querySelector('.view__placeholder')?.textContent).toContain('プロジェクト');
    expect(container.querySelector('button')).toBeNull();
  });

  test('currentFormulaVersionId が無ければ draft 誘導', () => {
    const view = createExportView();
    const container = buildContainer();
    view(container, {
      state: { ...INITIAL_STATE, project: stateWithDraft().project },
      navigate: jest.fn(),
    });
    expect(container.querySelector('.view__placeholder')?.textContent).toContain('/draft');
  });

  test('PubMed リンクを展開済みクエリから組み立てて表示する', () => {
    const view = createExportView();
    const container = buildContainer();
    view(container, { state: stateWithDraft(), navigate: jest.fn() });
    const link = container.querySelector<HTMLAnchorElement>('.export__pubmed-link a');
    expect(link?.href).toContain('pubmed.ncbi.nlm.nih.gov');
    const term = link ? new URL(link.href).searchParams.get('term') : null;
    expect(term).toBe('("Diabetes"[Mesh]) AND metformin');
    expect(term).not.toContain('#1');
  });

  test('PubMed セクションにコードブロックが無い場合はリンクを出さない', () => {
    const view = createExportView();
    const container = buildContainer();
    view(container, {
      state: stateWithDraft({
        currentFormulaMarkdown: '## PubMed\n\n本文だけ\n',
      }),
      navigate: jest.fn(),
    });
    expect(container.querySelector('.export__pubmed-link')).toBeNull();
  });

  test('#N 行が無いコードブロックでも PubMed リンクは出ない', () => {
    const view = createExportView();
    const container = buildContainer();
    view(container, {
      state: stateWithDraft({
        currentFormulaMarkdown: '## PubMed\n\n```\nno hashes here\n```\n',
      }),
      navigate: jest.fn(),
    });
    expect(container.querySelector('.export__pubmed-link')).toBeNull();
  });

  test('エクスポートボタンで onExport が呼ばれ、結果が <details> に表示される', async () => {
    const onExport = jest.fn(async () => sampleResult());
    const view = createExportView({ onExport });
    const container = buildContainer();
    view(container, { state: stateWithDraft(), navigate: jest.fn() });
    container.querySelector('button')!.click();
    await flushAsync();
    await flushAsync();
    expect(onExport).toHaveBeenCalledTimes(1);
    const details = container.querySelectorAll('details');
    expect(details).toHaveLength(2);
    expect(details[0]?.querySelector('summary')?.textContent).toContain('Cochrane');
    expect(details[1]?.querySelector('.export__warnings li')?.textContent).toContain('Condition');
    const downloadLinks = container.querySelectorAll<HTMLAnchorElement>('.export__download');
    expect(downloadLinks).toHaveLength(2);
    expect(downloadLinks[0]?.download).toBe('search-formula.central.md');
  });

  test('onExport が reject したらエラーボックスに表示する', async () => {
    const onExport = jest.fn().mockRejectedValue(new Error('boom'));
    const view = createExportView({ onExport });
    const container = buildContainer();
    view(container, { state: stateWithDraft(), navigate: jest.fn() });
    container.querySelector('button')!.click();
    await flushAsync();
    await flushAsync();
    expect(container.querySelector('.export__error')?.textContent).toBe('boom');
  });

  test('Error 以外の例外も String 化', async () => {
    const onExport = jest.fn().mockRejectedValue('rare');
    const view = createExportView({ onExport });
    const container = buildContainer();
    view(container, { state: stateWithDraft(), navigate: jest.fn() });
    container.querySelector('button')!.click();
    await flushAsync();
    await flushAsync();
    expect(container.querySelector('.export__error')?.textContent).toBe('rare');
  });

  test('onExport 未指定でもクリックで例外にならない', () => {
    const view = createExportView();
    const container = buildContainer();
    view(container, { state: stateWithDraft(), navigate: jest.fn() });
    expect(() => container.querySelector('button')!.click()).not.toThrow();
  });

  test('4 DB 全ての label が出ることを確認', async () => {
    const onExport = jest.fn(
      async (): Promise<ExportResult> => ({
        conversions: [
          { targetDb: 'central', convertedFormula: '#1', warnings: [] },
          { targetDb: 'dialog', convertedFormula: 'S1', warnings: [] },
          { targetDb: 'clinicaltrials', convertedFormula: '#1', warnings: [] },
          { targetDb: 'ictrp', convertedFormula: '#1', warnings: [] },
        ],
        entries: [],
      })
    );
    const view = createExportView({ onExport });
    const container = buildContainer();
    view(container, { state: stateWithDraft(), navigate: jest.fn() });
    container.querySelector('button')!.click();
    await flushAsync();
    await flushAsync();
    const summaries = Array.from(container.querySelectorAll('summary')).map(
      (s) => s.textContent
    );
    expect(summaries).toEqual([
      'Cochrane CENTRAL',
      'Embase (Dialog)',
      'ClinicalTrials.gov',
      'ICTRP',
    ]);
  });
});
