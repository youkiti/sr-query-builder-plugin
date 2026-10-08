import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { config } from 'dotenv';
import { TIERS, type Tier } from './bench';
import { aggregateVersion, scoreSubmission, type ReviewRuns, type RunScore, type SubmissionOutcome } from './metrics';
import { runPath, writeJson } from './runDir';
import { readSubmissionState, scoreMatchesSubmission, type StoredScore } from './scoreRuns';
import { readSeedSelection } from './seedSelect';
import { parseRunOptions, targetReviews, type RunRuntime } from './startRuns';
import { defaultRuntime } from './tool';

const EPSILON = 1e-12;
type Interval = [number, number];
type Improvement = 'recall' | 'hits';
type Direction = 'consistent' | 'inconsistent' | 'indeterminate';
interface Difference { base: number | null; candidate: number | null; difference: number | null }
export interface PairedSummary {
  reviews: number;
  allCapturedRate: Difference;
  studyRecall: Difference & { confidenceInterval: Interval | null };
  missedStudies: Difference;
  failureRate: Difference;
  hitsRatio: { reviews: number; ratio: number | null; confidenceInterval: Interval | null };
  hitsRatioAll: { reviews: number; median: number | null };
  medianHits: { base: number | null; candidate: number | null };
}
export interface Comparison extends PairedSummary {
  tiers: Record<Tier, PairedSummary>;
  verdict: 'adopt' | 'reject';
  reasons: string[];
  improvedBy: Improvement[];
  conditions: {
    allCapturedNonDecreasing: boolean;
    recallNonDecreasing: boolean;
    missedStudiesNonIncreasing: boolean;
    recallAndMissedNonWorsening: boolean;
    failureNonIncreasing: boolean;
    recallImproved: boolean;
    hitsImproved: boolean;
    anyImprovement: boolean;
    tierDirections: Record<Improvement, Record<Tier, Direction>>;
    tierDirectionConsistent: boolean;
  };
}
const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function bootstrap(values: number[], resamples: number, random: () => number): Interval | null {
  if (!values.length) return null;
  const samples = Array.from({ length: resamples }, () => {
    let total = 0;
    for (let i = 0; i < values.length; i++) total += values[Math.floor(random() * values.length)]!;
    return total / values.length;
  }).sort((a, b) => a - b);
  // 経験分布の隣接順位を線形補間するパーセンタイル法。
  const percentile = (p: number): number => {
    const index = (samples.length - 1) * p;
    const lower = Math.floor(index);
    return samples[lower]! + (samples[Math.ceil(index)]! - samples[lower]!) * (index - lower);
  };
  return [percentile(0.025), percentile(0.975)];
}

export function comparePaired(base: ReviewRuns[], candidate: ReviewRuns[], options: { resamples?: number; seed?: number; allowUnequalRuns?: boolean } = {}): Comparison {
  const { resamples = 10_000, seed = 20261005 } = options;
  if (!Number.isSafeInteger(resamples) || resamples <= 0 || !Number.isSafeInteger(seed)) throw new Error('再抽出回数と種が不正です');
  if (!base.length || !candidate.length) throw new Error('レビューが空です');
  const candidateById = new Map(candidate.map((row) => [row.pmcid, row]));
  if (new Set(base.map((row) => row.pmcid)).size !== base.length || candidateById.size !== candidate.length) throw new Error('レビューが重複しています');
  if (base.length !== candidate.length || base.some((row) => !candidateById.has(row.pmcid))) throw new Error('レビューの集合が一致しません');
  // 未確定と空の run は既存の集計と同じ検査で拒否する。
  aggregateVersion(base); aggregateVersion(candidate);
  const pairs = [...base].sort((a, b) => a.pmcid < b.pmcid ? -1 : a.pmcid > b.pmcid ? 1 : 0).map((row) => {
    const other = candidateById.get(row.pmcid)!;
    if (row.tier !== other.tier) throw new Error('対応するレビューのティアが一致しません');
    if (options.allowUnequalRuns !== true && row.runs.length !== other.runs.length) throw new Error('対応するレビューの実行数が一致しません');
    return { tier: row.tier, base: aggregateVersion([row]), candidate: aggregateVersion([other]) };
  });
  const summarize = (rows: typeof pairs): PairedSummary => {
    const random = mulberry32(seed);
    const difference = (key: 'allCapturedRate' | 'studyRecall' | 'missedStudies' | 'failureRate', sum = false): Difference => {
      const value = (side: 'base' | 'candidate') => rows.length
        ? (sum ? rows.reduce((total, row) => total + row[side][key]!, 0) : mean(rows.map((row) => row[side][key]!))) : sum ? 0 : null;
      const b = value('base'), c = value('candidate');
      return { base: b, candidate: c, difference: b === null || c === null ? null : c - b };
    };
    const median = (side: 'base' | 'candidate'): number | null => {
      const hits = rows.flatMap((row) => row[side].medianHits === null ? [] : [row[side].medianHits]).sort((a, b) => a - b);
      return hits.length ? (hits[Math.floor((hits.length - 1) / 2)]! + hits[Math.floor(hits.length / 2)]!) / 2 : null;
    };
    const recallInterval = bootstrap(rows.map((row) => row.candidate.studyRecall! - row.base.studyRecall!), resamples, random);
    const logs = rows.filter((row) => row.base.allCapturedRate === 1 && row.candidate.allCapturedRate === 1
      && row.base.medianHits !== null && row.candidate.medianHits !== null).map((row) => {
      if (row.base.medianHits! <= 0 || row.candidate.medianHits! <= 0) throw new Error('全捕捉レビューの件数は正である必要があります');
      return Math.log(row.candidate.medianHits!) - Math.log(row.base.medianHits!);
    });
    const logInterval = bootstrap(logs, resamples, random);
    const ratios = rows.flatMap((row) => row.base.medianHits !== null && row.base.medianHits > 0
      && row.candidate.medianHits !== null ? [row.candidate.medianHits / row.base.medianHits] : []).sort((a, b) => a - b);
    return { reviews: rows.length, allCapturedRate: difference('allCapturedRate'),
      studyRecall: { ...difference('studyRecall'), confidenceInterval: recallInterval }, missedStudies: difference('missedStudies', true),
      failureRate: difference('failureRate'), hitsRatio: { reviews: logs.length, ratio: logs.length ? Math.exp(mean(logs)) : null,
        confidenceInterval: logInterval ? [Math.exp(logInterval[0]), Math.exp(logInterval[1])] : null },
      hitsRatioAll: { reviews: ratios.length, median: ratios.length
        ? (ratios[Math.floor((ratios.length - 1) / 2)]! + ratios[Math.floor(ratios.length / 2)]!) / 2 : null },
      medianHits: { base: median('base'), candidate: median('candidate') } };
  };
  const overall = summarize(pairs);
  const tiers = { 'cc-by': summarize(pairs.filter((row) => row.tier === 'cc-by')),
    'cc-by-nc': summarize(pairs.filter((row) => row.tier === 'cc-by-nc')) };
  const reasons: string[] = [];
  const allCapturedNonDecreasing = overall.allCapturedRate.difference! >= -EPSILON;
  const recallNonDecreasing = overall.studyRecall.difference! >= -EPSILON;
  const missedStudiesNonIncreasing = overall.missedStudies.difference! <= EPSILON;
  const failureNonIncreasing = overall.failureRate.difference! <= EPSILON;
  if (!allCapturedNonDecreasing) reasons.push('全捕捉の割合が下がっています');
  if (!recallNonDecreasing) reasons.push('平均再現率（研究単位）が下がっています');
  if (!missedStudiesNonIncreasing) reasons.push('取りこぼし研究数の合計が増えています');
  if (!failureNonIncreasing) reasons.push('失敗率が上がっています');
  const recallImproved = overall.studyRecall.confidenceInterval![0] > EPSILON;
  const hitsImproved = overall.hitsRatio.confidenceInterval !== null && overall.hitsRatio.confidenceInterval[1] < 1 - EPSILON;
  const improvedBy: Improvement[] = [];
  if (recallImproved) improvedBy.push('recall');
  if (hitsImproved) improvedBy.push('hits');
  if (!improvedBy.length) reasons.push('再現率・件数のどちらも信頼区間による改善条件を満たしません');
  const direction = (metric: Improvement, tier: Tier): Direction => {
    const value = metric === 'recall' ? tiers[tier].studyRecall.difference
      : tiers[tier].hitsRatio.ratio === null ? null : Math.log(tiers[tier].hitsRatio.ratio!);
    const whole = metric === 'recall' ? overall.studyRecall.difference
      : overall.hitsRatio.ratio === null ? null : Math.log(overall.hitsRatio.ratio);
    const label = metric === 'recall' ? '再現率' : '件数';
    if (value === null || whole === null || Math.abs(value) <= EPSILON || Math.abs(whole) <= EPSILON) {
      if (improvedBy.includes(metric)) reasons.push(`${tier} の${label}の向きは判定不能です（差なし、または対象なし）`);
      return 'indeterminate';
    }
    if (Math.sign(value) !== Math.sign(whole)) {
      if (improvedBy.includes(metric)) reasons.push(`${tier} の${label}の向きが全体と一致しません`);
      return 'inconsistent';
    }
    return 'consistent';
  };
  const tierDirections = { recall: { 'cc-by': direction('recall', 'cc-by'), 'cc-by-nc': direction('recall', 'cc-by-nc') },
    hits: { 'cc-by': direction('hits', 'cc-by'), 'cc-by-nc': direction('hits', 'cc-by-nc') } };
  const tierDirectionConsistent = improvedBy.some((metric) => TIERS.every((tier) => tierDirections[metric][tier] !== 'inconsistent'));
  const adopt = allCapturedNonDecreasing && recallNonDecreasing && missedStudiesNonIncreasing && failureNonIncreasing
    && improvedBy.length > 0 && tierDirectionConsistent;
  if (adopt) reasons.push('悪化していない条件をすべて満たし、改善の根拠となる指標のティアの向きに不一致がありません');
  return { ...overall, tiers, verdict: adopt ? 'adopt' : 'reject', reasons, improvedBy,
    conditions: { allCapturedNonDecreasing, recallNonDecreasing, missedStudiesNonIncreasing,
      recallAndMissedNonWorsening: recallNonDecreasing && missedStudiesNonIncreasing, failureNonIncreasing,
      recallImproved, hitsImproved, anyImprovement: improvedBy.length > 0, tierDirections, tierDirectionConsistent } };
}

export function parseCompareOptions(args: string[]) {
  const remaining: string[] = [];
  const versions = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (key === '--candidate-runs-per-review') {
      const value = args[i + 1];
      if (versions.has(key) || !value || value.startsWith('--') || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) throw new Error('実行引数が不正です');
      versions.set(key, args[++i]!); continue;
    }
    if (key !== '--base' && key !== '--candidate' && key !== '--exclude-seeds') { remaining.push(key); continue; }
    if (versions.has(key) || !args[i + 1] || !/^[A-Za-z0-9_-]+$/.test(args[i + 1]!)) throw new Error('比較する版の指定が不正です');
    versions.set(key, args[++i]!);
  }
  if (!versions.has('--base') || !versions.has('--candidate') || remaining.includes('--version')) throw new Error('比較する版の指定が不足しているか不正です');
  if (versions.has('--candidate-runs-per-review') && versions.has('--exclude-seeds')) throw new Error('実行引数が不正です');
  const base = versions.get('--base')!, candidate = versions.get('--candidate')!;
  return { ...parseRunOptions([...remaining, '--version', base], '--runs'), base, candidate,
    ...(versions.has('--candidate-runs-per-review') ? { candidateRunsPerReview: Number(versions.get('--candidate-runs-per-review')) } : {}),
    ...(versions.has('--exclude-seeds') ? { excludeSeeds: versions.get('--exclude-seeds')! } : {}) };
}

export function main(args: string[], runtime: RunRuntime = defaultRuntime()): number {
  const options = parseCompareOptions(args);
  let reviews: ReturnType<typeof targetReviews>;
  try { reviews = targetReviews(options, runtime); }
  catch (error) {
    if (options.excludeSeeds) throw new Error('対象レビューの記録の読み込みに失敗しました');
    throw error;
  }
  const selections = new Map<string, ReturnType<typeof readSeedSelection>>();
  const removedPmids = new Map<string, Set<string>>();
  let droppedReviews = 0;
  if (options.excludeSeeds) {
    const paths = reviews.map((review) => ({ review, path: join(options.root, '_seeds', options.excludeSeeds!, `${review.pmcid}.json`) }));
    const missing = paths.filter(({ path }) => !existsSync(path)).length;
    if (missing) throw new Error(`シードの選定が ${missing} 件不足しています`);
    for (const { review, path } of paths) selections.set(review.pmcid, readSeedSelection(path));
    reviews = reviews.flatMap((review) => {
      const excluded = new Set(selections.get(review.pmcid)!.studyIds);
      const studies = review.studies.filter((study) => !excluded.has(study.id));
      if (!studies.length) { droppedReviews++; return []; }
      const retained = new Set(studies.flatMap((study) => study.pmids));
      const removed = new Set(review.studies.filter((study) => excluded.has(study.id)).flatMap((study) => study.pmids).filter((pmid) => !retained.has(pmid)));
      removedPmids.set(review.pmcid, removed);
      return [{ ...review, studies, evaluablePmids: review.evaluablePmids.filter((pmid) => !removed.has(pmid)) }];
    });
  }
  let missing = 0, unscored = 0, invalidDates = 0;
  const load = (version: string, runsPerReview: number) => {
    const dates = new Set<string>();
    const rows: ReviewRuns[] = reviews.map((review) => {
      const runs: RunScore[] = [];
      for (let i = 1; i <= runsPerReview; i++) {
        const dir = runPath(options.root, version, review.pmcid, i);
        const path = join(dir, 'score.json');
        if (!existsSync(path)) { missing++; continue; }
        let score: StoredScore | null;
        try {
          score = JSON.parse(readFileSync(path, 'utf8')) as typeof score;
          if (!score || !scoreMatchesSubmission(score, readSubmissionState(dir))) { unscored++; continue; }
        }
        catch { unscored++; continue; }
        const date = typeof score.measuredAt === 'string' ? Date.parse(score.measuredAt) : NaN;
        if (!Number.isFinite(date)) invalidDates++;
        else dates.add(new Date(date).toISOString().slice(0, 10));
        if (options.excludeSeeds) {
          const outcome = (score as StoredScore & { outcome?: SubmissionOutcome }).outcome;
          if (!outcome || !['measured', 'invalid_submission', 'no_submission', 'measurement_failed'].includes(outcome.status)) { unscored++; continue; }
          try {
            runs.push(scoreSubmission(review.studies, review.evaluablePmids, outcome.status === 'measured'
              ? { ...outcome, capturedPmids: outcome.capturedPmids.filter((pmid) => !removedPmids.get(review.pmcid)!.has(pmid)) } : outcome));
          } catch { unscored++; }
        } else runs.push(score);
      }
      return { pmcid: review.pmcid, tier: review.tier, runs };
    });
    return { rows, dates: [...dates].sort() };
  };
  const base = load(options.base, options.runsPerReview), candidate = load(options.candidate, options.candidateRunsPerReview ?? options.runsPerReview);
  if (missing || unscored || invalidDates) throw new Error(`採点記録の不足 ${missing} 件、未採点 ${unscored} 件、測定日不正 ${invalidDates} 件`);
  const sameDay = base.dates.length === 1 && candidate.dates.length === 1 && base.dates[0] === candidate.dates[0];
  const seeded = (row: ReviewRuns) => !!selections.get(row.pmcid)?.pmids.length;
  const seededReviews = base.rows.filter(seeded).length;
  const report = { base: options.base, candidate: options.candidate, subset: options.subset, reviews: reviews.length,
    runsPerReview: options.runsPerReview, generatedAt: runtime.now().toISOString(), sameDay,
    ...(options.candidateRunsPerReview !== undefined ? { candidateRunsPerReview: options.candidateRunsPerReview } : {}),
    measuredDates: { base: base.dates, candidate: candidate.dates },
    comparison: options.excludeSeeds && !reviews.length ? null : comparePaired(base.rows, candidate.rows,
      options.candidateRunsPerReview !== undefined ? { allowUnequalRuns: true } : {}),
    ...(options.excludeSeeds ? { excludeSeeds: options.excludeSeeds, seededReviews, unseededReviews: reviews.length - seededReviews, droppedReviews,
      seededOnly: seededReviews ? comparePaired(base.rows.filter(seeded), candidate.rows.filter(seeded)) : null } : {}) };
  const reportsDir = runtime.reportsDir ?? resolve(__dirname, '../reports');
  try {
    mkdirSync(reportsDir, { recursive: true });
    writeJson(join(reportsDir, `compare-${options.base}-${options.candidate}-${options.subset}${options.excludeSeeds ? `-noseed-${options.excludeSeeds}` : ''}.json`), report);
  } catch (error) {
    if (options.excludeSeeds) throw new Error('比較のレポートの書き込みに失敗しました');
    throw error;
  }
  if (!sameDay) runtime.stdout('警告: 両版の測定日が同じ UTC 日に収まっていません\n');
  runtime.stdout(JSON.stringify(report, null, 2) + '\n');
  return 0;
}
if (require.main === module) {
  config();
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; }
}
