import { buildFormulaV1, buildValidationSummary } from '@/demo/scenario';
import { SEED_PMIDS } from '@/demo/corpus';
import { formatValidationProgress, renderValidationResults, summaryStatusText } from './validationResults';
import { setUiLanguage } from '@/lib/i18n';

afterEach(() => setUiLanguage('ja'));

test('English validation results and progress use the current language', () => {
  setUiLanguage('en');
  const summary = buildValidationSummary(buildFormulaV1().markdown, []);
  const container = document.createElement('div');
  renderValidationResults(document, container, summary, {}, null);
  expect(container.querySelector('h3')!.textContent).toBe('Hits by line');
  expect(container.textContent).toContain('Final formula and seed capture');
  expect(summaryStatusText(summary)).toBe('Validation complete (0/0 eligible seeds)');
  expect(formatValidationProgress({ step: 'line_hits', blockIndex: 1, blockCount: 2 })).toBe('Counting hits by line (block 1/2)');
});

describe('捕捉率の表示', () => {
  test.each([
    { seeds: [], expectedRate: null, expected: '有効シード 0 件のため未計測' },
    { seeds: [SEED_PMIDS[0]], expectedRate: 0, expected: '捕捉率: 0.0% (0/1)' },
  ])('デモの有効シード $seeds を未計測と実測 0 に区別する', ({ seeds, expectedRate, expected }) => {
    const summary = buildValidationSummary(buildFormulaV1().markdown, seeds, []);
    expect(summary.finalQuery.captureRate).toBe(expectedRate);
    expect(summary.finalQueryError).toBeNull();
    const container = document.createElement('div');
    renderValidationResults(document, container, summary, {}, null);
    const text = container.querySelector('.validate__final')!.textContent;
    expect(text).toContain(expected);
    if (expectedRate === null) expect(text).not.toContain('0.0%');
    else expect(text).not.toContain('未計測');
  });

  test('検証失敗の null はシード不足による未計測と表示しない', () => {
    const summary = buildValidationSummary(buildFormulaV1().markdown, []);
    summary.finalQueryError = 'NCBI down';
    const container = document.createElement('div');
    renderValidationResults(document, container, summary, {}, null);
    const text = container.querySelector('.validate__final')!.textContent;
    expect(text).toContain('final_query の取得に失敗しました: NCBI down');
    expect(text).not.toContain('未計測');
    expect(text).not.toContain('0.0%');
  });
});
