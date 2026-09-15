import type { LLMProvider } from '@/lib/llm';
import {
  COCHRANE_HSSS_2024_PUBMED,
  HIT_THRESHOLD,
  designDefaultFilters,
  explainDefaultFilterSelection,
  getDefaultSelectedFilterIds,
  proposeExcessFilters,
} from './filterDesigner';

describe('designDefaultFilters', () => {
  test('study_design=RCT で Cochrane RCT フィルタを追加', () => {
    const result = designDefaultFilters({ studyDesign: 'RCT' });
    expect(result.filters).toHaveLength(1);
    expect(result.filters[0]?.blockId).toBe('RCTfilter');
    expect(result.filters[0]?.expression).toBe(COCHRANE_HSSS_2024_PUBMED);
    expect(result.appendToCombination).toBe(' AND #RCTfilter');
  });

  test('study_design=randomized clinical trial も RCT として扱う', () => {
    const result = designDefaultFilters({ studyDesign: 'randomized clinical trial' });
    expect(result.filters[0]?.blockId).toBe('RCTfilter');
  });

  test('observational では何も追加しない', () => {
    const result = designDefaultFilters({ studyDesign: 'observational' });
    expect(result.filters).toEqual([]);
    expect(result.appendToCombination).toBe('');
  });

  test('年代範囲 from のみ指定', () => {
    const result = designDefaultFilters({ studyDesign: 'any', yearRange: { fromYear: 2015 } });
    const dateFilter = result.filters.find((f) => f.blockId === 'DateFilter');
    expect(dateFilter?.expression).toContain('"2015/01/01"');
    expect(dateFilter?.expression).toContain('"3000/12/31"');
    expect(result.appendToCombination).toBe(' AND #DateFilter');
  });

  test('年代範囲 to のみ指定', () => {
    const result = designDefaultFilters({ studyDesign: 'any', yearRange: { toYear: 2020 } });
    const dateFilter = result.filters.find((f) => f.blockId === 'DateFilter');
    expect(dateFilter?.expression).toContain('"0001/01/01"');
    expect(dateFilter?.expression).toContain('"2020/12/31"');
  });

  test('年代範囲が両方 undefined ならフィルタを作らない', () => {
    const result = designDefaultFilters({ studyDesign: 'any', yearRange: {} });
    expect(result.filters).toEqual([]);
  });

  test('RCT + 年代範囲で 2 つのフィルタ', () => {
    const result = designDefaultFilters({
      studyDesign: 'RCT',
      yearRange: { fromYear: 2015, toYear: 2024 },
    });
    expect(result.filters).toHaveLength(2);
    expect(result.appendToCombination).toBe(' AND #RCTfilter AND #DateFilter');
  });

  test('excessFilterCandidates は常に空（既定経路）', () => {
    const result = designDefaultFilters({ studyDesign: 'RCT' });
    expect(result.excessFilterCandidates).toEqual([]);
  });
});

describe('proposeExcessFilters', () => {
  function provider(text: string): { provider: LLMProvider; calls: number } {
    let calls = 0;
    return {
      get calls(): number {
        return calls;
      },
      provider: {
        providerId: 'gemini',
        model: 'test',
        chat: async () => {
          calls += 1;
          return { text, tokensIn: null, tokensOut: null, raw: {} };
        },
      },
    };
  }

  test(`ヒット ≦ ${HIT_THRESHOLD} なら LLM を呼ばず空配列`, async () => {
    const counter = provider('{"candidates":[]}');
    await expect(
      proposeExcessFilters({ studyDesign: 'any', hitCount: HIT_THRESHOLD }, counter.provider)
    ).resolves.toEqual([]);
    expect(counter.calls).toBe(0);
  });

  test('ヒット未指定（null）なら 0 件として LLM を呼ばない', async () => {
    const counter = provider('{}');
    await expect(
      proposeExcessFilters({ studyDesign: 'any' }, counter.provider)
    ).resolves.toEqual([]);
    expect(counter.calls).toBe(0);
  });

  test('閾値超で LLM を呼び、候補を返す', async () => {
    const counter = provider(
      JSON.stringify({
        candidates: [
          { label: '研究タイプ', expression: 'systematic[sb]', rationale: '効果と漏れリスク' },
        ],
      })
    );
    const result = await proposeExcessFilters(
      { studyDesign: 'any', hitCount: HIT_THRESHOLD + 1 },
      counter.provider
    );
    expect(counter.calls).toBe(1);
    expect(result).toEqual([
      { label: '研究タイプ', expression: 'systematic[sb]', rationale: '効果と漏れリスク' },
    ]);
  });

  test('candidates 要素のフィールドが欠けても空文字で埋める', async () => {
    const counter = provider('{"candidates":[{}]}');
    const result = await proposeExcessFilters(
      { studyDesign: 'any', hitCount: HIT_THRESHOLD + 100 },
      counter.provider
    );
    expect(result[0]).toEqual({ label: '', expression: '', rationale: '' });
  });

  test('candidates が無い JSON は空配列', async () => {
    const counter = provider('{}');
    const result = await proposeExcessFilters(
      { studyDesign: 'any', hitCount: HIT_THRESHOLD + 1 },
      counter.provider
    );
    expect(result).toEqual([]);
  });
});

test.each([
  ['RCT', true, false], ['RCT / observational', false, true],
  ['RCT and prospective cohort', false, true], ['randomised or non-randomised', false, true],
  ['any', false, false], ['non-RCT', false, false], ['nonrandomized', false, false],
  ['non randomised', false, false], ['quasi-randomised', false, false],
  ['observational', false, false], ['randomized', true, false],
  ['RCT accompanying', true, false],
] as const)('研究デザイン %s の既定選択と理由を統一する', (studyDesign, selected, reason) => {
  const explanation = explainDefaultFilterSelection(studyDesign);
  expect(explanation.selectedIds.includes('RCTfilter')).toBe(selected);
  expect(explanation.rctSkippedReason !== null).toBe(reason);
  expect(getDefaultSelectedFilterIds(studyDesign)).toEqual(explanation.selectedIds);
  expect(designDefaultFilters({ studyDesign }).filters.some((f) => f.blockId === 'RCTfilter')).toBe(selected);
});

test.each([
  'case-control', 'case control', 'cross-sectional', 'cross sectional',
  'non-RCT', 'non randomized', 'nonrandomised', 'quasi-experimental', 'quasi-randomized',
  'before-after', 'before and after', 'interrupted time series', 'case series', 'any',
])('RCT と %s の混在では自動選択しない', (term) => {
  expect(explainDefaultFilterSelection(`RCT / ${term}`)).toEqual({
    selectedIds: [], rctSkippedReason: expect.stringContaining(`（${term}）`),
  });
});

test('理由は元表記を保ち、同じ語を重複させない', () => {
  expect(explainDefaultFilterSelection('RCT / Observational / observational / cohort').rctSkippedReason)
    .toContain('（Observational、cohort）');
});

test('傘レビューの自動選択は維持する', () => {
  expect(getDefaultSelectedFilterIds('umbrella review')).toEqual(['SRfilter']);
  expect(getDefaultSelectedFilterIds('overview of review')).toEqual(['SRfilter']);
});
