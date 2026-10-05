import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { TIERS, type BenchReview, type BenchRow, type GoldRow } from './bench';
import type { EvaluableRecord } from './evaluable';

export const pmids = ['00000001', '00000002', '00000003', '00000004'];
export function review(index = 1): BenchReview {
  return { pmcid: `PMC${String(index).padStart(7, '0')}`, cochrane_id: `CD${String(index).padStart(6, '0')}`, tier: 'cc-by',
    cutoff_date: '2020-01-31', cutoffDate: '2020-01-31', n_records: 200, included_not_retrieved: pmids.slice(1),
    n_included_pmids: 4, n_included_studies: 4, included_studies_retrieved: 2, included_recall: 0.25, included_study_recall: 0.5,
    includedPmids: [...pmids], studies: [{ id: 'study:合成研究甲', pmids: pmids.slice(0, 2) },
      { id: 'study:合成研究乙', pmids: [pmids[0]!] }, ...pmids.slice(2).map((pmid) => ({ id: `pmid:${pmid}`, pmids: [pmid] }))] };
}
export const record = (row = review()): EvaluableRecord => ({ pmcid: row.pmcid, cutoffDate: row.cutoffDate,
  measuredAt: '2026-01-01T00:00:00Z', existing: [...pmids], withinCutoff: [...pmids] });
export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}
export function writeLines(path: string, rows: unknown[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join('\n'));
}
export function fixture(dir: string, rows: BenchRow[] = [review(), { ...review(2), tier: 'cc-by-nc' }]): void {
  for (const tier of TIERS) {
    const selected = rows.filter((row) => row.tier === tier);
    const base = join(dir, 'data/processed', tier);
    writeLines(join(base, 'search_screen_benchmark/reviews.jsonl'), selected);
    writeLines(join(base, 'gold/task2_search_screen.jsonl'), selected.map((row): GoldRow => ({ pmcid: row.pmcid,
      included_pmids: [...pmids, pmids[0]!], pmid_to_study_id: { [pmids[0]!]: [' 合成研究甲 ', '合成研究乙', '合成研究乙'],
        [pmids[1]!]: '合成研究甲', [pmids[2]!]: [' ', ''] } })));
    writeJson(join(base, 'search_screen_benchmark/summary.json'), { study_macro_recall: selected.length ? 0.5 : 0, pmid_macro_recall: selected.length ? 0.25 : 0 });
    for (const row of selected) writeJson(join(dir, 'data/interim', tier, 'parsed', `${row.pmcid}.json`), {
      title: '合成レビューの題', objectives: '合成の目的', eligibility: { types_of_studies: '合成の研究種別', types_of_participants: '合成の対象',
        types_of_interventions: '合成の介入', types_of_outcomes: '合成の評価項目' },
      search_methods: '混入禁止の検索方法', search_strategies: '混入禁止の検索式', results: '混入禁止の結果',
      license: tier, included_studies: [] });
  }
}
