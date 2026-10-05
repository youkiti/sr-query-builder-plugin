import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ParsedReview } from '../../query-optimization-bench/prepare';

export const TIERS = ['cc-by', 'cc-by-nc'] as const;
export type Tier = typeof TIERS[number];
export interface Study { id: string; pmids: string[] }
export interface BenchRow {
  pmcid: string;
  cochrane_id: string | null;
  tier: Tier;
  cutoff_date: string;
  n_records: number;
  included_not_retrieved: string[];
  n_included_pmids: number;
  n_included_studies: number;
  included_studies_retrieved: number;
  included_recall: number;
  included_study_recall: number;
}
export interface BenchReview extends BenchRow {
  cutoffDate: string;
  studies: Study[];
  includedPmids: string[];
}
export interface GoldRow {
  pmcid: string;
  included_pmids: string[];
  pmid_to_study_id: Record<string, string | string[]>;
}
export interface BenchSummary { study_macro_recall: number; pmid_macro_recall: number }

export function resolveBenchDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.COCHRANE_BENCH_DIR;
  if (!dir?.trim()) throw new Error('COCHRANE_BENCH_DIR が未設定です');
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error('COCHRANE_BENCH_DIR のディレクトリが存在しません');
  return resolve(dir);
}

export function readJsonLines<T>(path: string): T[] {
  if (!existsSync(path)) throw new Error(`ファイルが見つかりません: ${path}`);
  return readFileSync(path, 'utf8').split(/\r?\n/).filter((line) => line.trim()).map((line, index) => {
    try { return JSON.parse(line) as T; }
    catch { throw new Error(`JSON の形式が不正です: ${path} の ${index + 1} 行目`); }
  });
}

export function loadReviews(benchDir: string): BenchReview[] {
  const seen = new Set<string>();
  return TIERS.flatMap((tier) => {
    const base = join(benchDir, 'data/processed', tier);
    const gold = new Map(readJsonLines<GoldRow>(join(base, 'gold/task2_search_screen.jsonl')).map((row) => [row.pmcid, row]));
    return readJsonLines<BenchRow>(join(base, 'search_screen_benchmark/reviews.jsonl')).map((row) => {
      if (seen.has(row.pmcid)) throw new Error(`PMCID が重複しています: ${row.pmcid}`);
      seen.add(row.pmcid);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(row.cutoff_date)) throw new Error(`検索日の形式が不正です: ${row.pmcid}`);
      const entry = gold.get(row.pmcid);
      if (!entry) throw new Error(`gold の対応行がありません: ${row.pmcid}`);
      const includedPmids = [...new Set(entry.included_pmids)];
      const named = new Map<string, Set<string>>();
      const unnamed: Study[] = [];
      for (const pmid of includedPmids) {
        const value = entry.pmid_to_study_id[pmid];
        const names = [...new Set((typeof value === 'string' ? [value] : value ?? []).map((name) => name.trim()).filter(Boolean))];
        if (!names.length) unnamed.push({ id: `pmid:${pmid}`, pmids: [pmid] });
        for (const name of names) {
          if (!named.has(name)) named.set(name, new Set());
          named.get(name)!.add(pmid);
        }
      }
      // 接頭辞を分け、研究名と名前の無い報告の識別子が衝突しないようにする。
      const studies = [...named].map(([name, pmids]) => ({ id: `study:${name}`, pmids: [...pmids] })).concat(unnamed);
      return { ...row, tier, cutoffDate: row.cutoff_date, studies, includedPmids };
    });
  });
}

export function loadParsed(benchDir: string, review: BenchReview): ParsedReview {
  return JSON.parse(readFileSync(join(benchDir, 'data/interim', review.tier, 'parsed', `${review.pmcid}.json`), 'utf8')) as ParsedReview;
}

export function loadSummaries(benchDir: string): Record<Tier, BenchSummary> {
  return Object.fromEntries(TIERS.map((tier) => [tier, JSON.parse(readFileSync(
    join(benchDir, 'data/processed', tier, 'search_screen_benchmark/summary.json'), 'utf8')) as BenchSummary])) as Record<Tier, BenchSummary>;
}
