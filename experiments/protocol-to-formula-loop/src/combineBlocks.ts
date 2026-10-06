import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { config } from 'dotenv';
import { esearch } from '../../../src/lib/ncbi/eutils';
import { redact } from '../../query-optimization-bench/ncbiEval';
import { analyzeSource, chooseAssignment, mergedQuery, overlapCoefficient, type MergeGroup, type SourceAnalysis, type UnusableReason } from './blockMerge';
import { casesDir } from './cases';
import { loadConditions } from './conditions';
import { quantile } from './diagnose';
import { createDeps, isQueryRejection } from './ncbi';
import { createRun, readRun, recordToolCall, runPath, writeJson } from './runDir';
import { readSubmissionState } from './scoreRuns';
import { parseRunOptions, targetReviews, type RunRuntime } from './startRuns';
import { validateFormulaMd } from './submission';
import { defaultRuntime } from './tool';

type Thresholds = { minOverlap: number; minMargin: number; maxConcepts: number };
type RejectedReason = 'below_min_overlap' | 'below_min_margin' | 'query_rejected';
type Outcome = 'no_submission' | 'merged_all' | 'merged_partial' | 'formula_or';
interface SourceRecord { combinedFrom: number; usable: boolean; reason?: UnusableReason | 'no_submission'; concepts: number; filters: number }
interface MemberRecord {
  combinedFrom: number; accepted: boolean; score: number | null; margin: number | null; minPair: number | null;
  permutation: number[]; rejectedReason?: RejectedReason;
}
interface CombineRecord {
  sources: SourceRecord[]; groups: { reference: number; members: MemberRecord[] }[]; outcome: Outcome; thresholds: Thresholds;
}
interface Source { combinedFrom: number; query: string; analysis: SourceAnalysis; cutoffDate: string }

function summarize(records: CombineRecord[]) {
  const outcomes: Record<Outcome, number> = { no_submission: 0, merged_all: 0, merged_partial: 0, formula_or: 0 };
  const reasons: Record<UnusableReason, number> = { invalid: 0, query_mismatch: 0, undetermined: 0, no_concept: 0, too_many_concepts: 0 };
  const rejected: Record<RejectedReason, number> = { below_min_overlap: 0, below_min_margin: 0, query_rejected: 0 };
  const sources = { total: 0, usable: 0, reasons };
  const members = records.flatMap((record) => record.groups.flatMap((group) => group.members));
  for (const record of records) {
    outcomes[record.outcome]++;
    for (const source of record.sources) {
      if (source.reason === 'no_submission') continue;
      sources.total++;
      if (source.usable) sources.usable++;
      else if (source.reason) reasons[source.reason]++;
    }
  }
  for (const member of members) if (member.rejectedReason) rejected[member.rejectedReason]++;
  const quantiles = (key: 'score' | 'margin' | 'minPair') => {
    const values = members.flatMap((member) => member[key] === null ? [] : [member[key]]);
    return { min: quantile(values, 0), q1: quantile(values, 0.25), median: quantile(values, 0.5), q3: quantile(values, 0.75), max: quantile(values, 1) };
  };
  return { outcomes, sources, alignments: { attempted: members.length, accepted: members.filter((member) => member.accepted).length, rejected },
    scoreQuantiles: quantiles('score'), marginQuantiles: quantiles('margin'), minPairQuantiles: quantiles('minPair') };
}

async function combine(args: string[], runtime: RunRuntime): Promise<number> {
  const options = parseRunOptions(args, '--runs');
  const conditions = loadConditions(options.version, runtime.harnessDir);
  if (!conditions.combine || !('from' in conditions.combine) || !conditions.combine.blocks) throw new Error('概念ごとに束ねる条件がありません');
  const { from, k, blocks: thresholds } = conditions.combine;
  const reviews = targetReviews(options, runtime);
  const all = reviews.flatMap((review) => Array.from({ length: options.runsPerReview }, (_, i) => ({
    review, runIndex: i + 1, dir: runPath(options.root, options.version, review.pmcid, i + 1),
    sources: Array.from({ length: k }, (_, offset) => {
      const runIndex = i * k + offset + 1;
      return { combinedFrom: runIndex, dir: runPath(options.root, from, review.pmcid, runIndex) };
    }),
  })));
  const missing = all.flatMap((run) => run.sources).filter(({ dir }) => !existsSync(dir) || !statSync(dir).isDirectory()).length;
  const unfinished = all.filter(({ dir }) => existsSync(dir) && !existsSync(join(dir, 'combine.json'))).length;
  if (missing) throw new Error(`元の実行フォルダが ${missing} 件不足しています`);
  if (unfinished) throw new Error(`束ねた版の実行フォルダが ${unfinished} 件、作りかけで残っています`);
  const { env, fetchImpl, sleep, now, stdout } = runtime;
  const base = createDeps({ env, fetchImpl, sleep });
  let measured = 0, cached = 0, created = 0, skipped = 0, submitted = 0;
  const cacheDir = join(options.root, '_cache', 'counts');
  const count = async (query: string, cutoffDate: string): Promise<number> => {
    const path = join(cacheDir, createHash('sha256').update(cutoffDate + '\n' + query).digest('hex') + '.json');
    if (existsSync(path)) {
      const saved = JSON.parse(readFileSync(path, 'utf8')) as { count: number };
      if (!Number.isInteger(saved.count) || saved.count < 0) throw new Error('件数キャッシュが不正です');
      cached++;
      return saved.count;
    }
    const deps = { ...createDeps({ env, fetchImpl, sleep, cutoffDate }), rateLimiter: base.rateLimiter };
    let result: number;
    try { result = (await esearch(query, deps, { retmax: 0 })).count; }
    catch (error) {
      if (isQueryRejection(error)) throw error;
      // 原因は手元の標準エラーにだけ出す（集計ファイルには書かない）。キーは伏せる。
      throw new Error('件数の測定に失敗しました（結果不明）: ' + redact(error instanceof Error ? error.message : String(error), [env.NCBI_API_KEY ?? '']));
    }
    mkdirSync(cacheDir, { recursive: true });
    writeJson(path, { count: result, measuredAt: now().toISOString() });
    measured++;
    return result;
  };
  const records: CombineRecord[] = [];
  for (const { review, runIndex, dir, sources } of all) {
    const recordPath = join(dir, 'combine.json');
    if (existsSync(recordPath)) {
      records.push(JSON.parse(readFileSync(recordPath, 'utf8')) as CombineRecord);
      skipped++;
      continue;
    }
    const record: CombineRecord = { sources: [], groups: [], outcome: 'no_submission', thresholds };
    const available: Source[] = [];
    for (const source of sources) {
      const { submission } = readSubmissionState(source.dir);
      if (!submission) {
        record.sources.push({ combinedFrom: source.combinedFrom, usable: false, reason: 'no_submission', concepts: 0, filters: 0 });
        continue;
      }
      let analysis: SourceAnalysis;
      try { analysis = analyzeSource(readFileSync(join(source.dir, 'submissions', `${submission.number}.md`), 'utf8'), submission.query, thresholds.maxConcepts); }
      catch { analysis = { usable: false, reason: 'invalid' }; }
      const info = readRun(source.dir);
      if (info.cutoffDate !== review.cutoffDate) throw new Error('元の実行の検索日が対象と一致しません');
      available.push({ combinedFrom: source.combinedFrom, query: submission.query, analysis, cutoffDate: info.cutoffDate });
      record.sources.push({ combinedFrom: source.combinedFrom, usable: analysis.usable,
        ...(!analysis.usable ? { reason: analysis.reason } : {}),
        concepts: analysis.usable ? analysis.concepts.length : 0, filters: analysis.usable ? analysis.filters.length : 0 });
    }
    const bySignature = new Map<string, (Source & { analysis: Extract<SourceAnalysis, { usable: true }> })[]>();
    for (const source of available) if (source.analysis.usable) {
      const group = bySignature.get(source.analysis.signature) ?? [];
      group.push({ ...source, analysis: source.analysis });
      bySignature.set(source.analysis.signature, group);
    }
    const merged: MergeGroup[] = [], included = new Set<number>();
    for (const group of bySignature.values()) {
      if (group.length < 2) continue;
      const reference = group[0]!;
      const alignment = { reference: reference.combinedFrom, members: [] as MemberRecord[] };
      record.groups.push(alignment);
      const reject = (combinedFrom: number): MemberRecord => ({ combinedFrom, accepted: false, score: null, margin: null,
        minPair: null, permutation: [], rejectedReason: 'query_rejected' });
      const referenceCounts: number[] = [];
      try {
        for (const expression of reference.analysis.concepts) referenceCounts.push(await count(`(${expression})`, reference.cutoffDate));
      } catch (error) {
        if (!isQueryRejection(error)) throw error;
        alignment.members.push(...group.slice(1).map((source) => reject(source.combinedFrom)));
        continue;
      }
      const concepts = reference.analysis.concepts.map((expression) => [expression]);
      const accepted = [reference.combinedFrom];
      for (const source of group.slice(1)) {
        try {
          const otherCounts: number[] = [];
          for (const expression of source.analysis.concepts) otherCounts.push(await count(`(${expression})`, source.cutoffDate));
          const matrix: number[][] = [];
          for (const [i, expression] of reference.analysis.concepts.entries()) {
            const row: number[] = [];
            for (const [j, other] of source.analysis.concepts.entries()) {
              const both = await count(`(${expression}) AND (${other})`, source.cutoffDate);
              row.push(overlapCoefficient(referenceCounts[i]!, otherCounts[j]!, both));
            }
            matrix.push(row);
          }
          const assignment = chooseAssignment(matrix, thresholds);
          alignment.members.push({ combinedFrom: source.combinedFrom, ...assignment,
            ...(!assignment.accepted ? { rejectedReason: assignment.minPair < thresholds.minOverlap
              ? 'below_min_overlap' as const : 'below_min_margin' as const } : {}) });
          if (assignment.accepted) {
            accepted.push(source.combinedFrom);
            assignment.permutation.forEach((j, i) => concepts[i]!.push(source.analysis.concepts[j]!));
          }
        } catch (error) {
          if (!isQueryRejection(error)) throw error;
          alignment.members.push(reject(source.combinedFrom));
        }
      }
      if (accepted.length >= 2) {
        merged.push({ concepts, filters: reference.analysis.filters });
        accepted.forEach((index) => included.add(index));
      }
    }
    const leftovers = available.filter((source) => !included.has(source.combinedFrom)).map((source) => source.query);
    record.outcome = !available.length ? 'no_submission' : !merged.length ? 'formula_or'
      : merged.length === 1 && !leftovers.length ? 'merged_all' : 'merged_partial';
    const md = '## PubMed/MEDLINE\n\n```\n#1 ' + mergedQuery(merged, leftovers) + '\n```\n';
    const validated = available.length ? validateFormulaMd(md) : null;
    if (validated && !validated.ok) throw new Error('束ねた式の検査に失敗しました: 式の構造が不正です');
    createRun({ root: options.root, version: options.version, pmcid: review.pmcid, runIndex,
      cutoffDate: review.cutoffDate, protocolPath: join(runtime.casesDir ?? casesDir(), review.pmcid, 'protocol.md'),
      conditions, now: runtime.now });
    if (validated?.ok) {
      const submittedAt = runtime.now().toISOString();
      mkdirSync(join(dir, 'submissions'));
      writeFileSync(join(dir, 'submissions', '1.md'), md);
      writeJson(join(dir, 'submission.json'), { number: 1, submittedAt, query: validated.query,
        combinedFrom: available.map((source) => source.combinedFrom) });
      recordToolCall(dir, { measurements: 0, submissions: 1 }, { at: submittedAt, command: 'submit', args: '束ねた式 1 件',
        result: '成功', remaining: { measurements: conditions.maxMeasurements, submissions: conditions.maxSubmissions - 1 } });
      submitted++;
    }
    writeJson(recordPath, record);
    records.push(record);
    created++;
  }
  const summary = summarize(records);
  const reportsDir = runtime.reportsDir ?? resolve(__dirname, '../reports');
  mkdirSync(reportsDir, { recursive: true });
  writeJson(join(reportsDir, `combine-${options.version}-${options.subset}.json`), { version: options.version, subset: options.subset,
    reviews: reviews.length, runsPerReview: options.runsPerReview, generatedAt: now().toISOString(), thresholds, ...summary });
  stdout(`作成: ${created} 件\n`);
  stdout(`既にあり飛ばした: ${skipped} 件\n`);
  stdout(`束ねた式: ${submitted} 件\n`);
  stdout(`提出なし: ${summary.outcomes.no_submission} 件\n`);
  stdout(`概念ごとに束ねた（全部）: ${summary.outcomes.merged_all} 件、（一部）: ${summary.outcomes.merged_partial} 件、完成式の OR のまま: ${summary.outcomes.formula_or} 件\n`);
  stdout(`測定: 新規 ${measured} 回、キャッシュ ${cached} 回\n`);
  return 0;
}

export async function main(args: string[], runtime: RunRuntime = defaultRuntime()): Promise<number> {
  try { return await combine(args, runtime); }
  catch (error) {
    // ファイルのパスや壊れた JSON の断片を公開出力へ持ち出さない。
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException)?.code) throw new Error('束ねる処理のファイルの読み書きに失敗しました');
    throw error;
  }
}
if (require.main === module) {
  config();
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(redact(String(error), [process.env.NCBI_API_KEY ?? '']) + '\n'); process.exitCode = 1;
  });
}
