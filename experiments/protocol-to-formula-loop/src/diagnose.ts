import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { config } from 'dotenv';
import { expandFormula } from '../../../src/features/validation/expandFormula';
import { esearch } from '../../../src/lib/ncbi/eutils';
import type { FormulaBlock, PubmedFormula } from '../../../src/lib/search-formula-md/types';
import { classifyFieldTag, tokenizeExpression } from '../../../src/lib/search-formula-md/expression';
import { capturedGold, redact } from '../../query-optimization-bench/ncbiEval';
import type { Study } from './bench';
import type { SubmissionOutcome } from './metrics';
import { createDeps } from './ncbi';
import { readRun, runPath, writeJson } from './runDir';
import { readSubmissionState, scoreMatchesSubmission, type StoredScore } from './scoreRuns';
import { parseRunOptions, targetReviews, type RunRuntime } from './startRuns';
import { validateFormulaMd } from './submission';
import { defaultRuntime } from './tool';

type LineKind = 'concept' | 'filter';
const CATEGORIES = ['single_concept', 'single_filter', 'multiple', 'none', 'no_lines', 'undetermined'] as const;
type Category = typeof CATEGORIES[number];
type Counts = Record<Category, number>;
export interface DiagnosisLine {
  id: string; kind: LineKind; hits: number | null; capturedStudies: number;
  missedStudies: number; meshTerms: number; freewordTerms: number; plainTerms: number;
}
export interface Diagnosis {
  status: 'diagnosed'; submission: NonNullable<ReturnType<typeof readSubmissionState>['fingerprint']>;
  scoreMeasuredAt: string; unusedLines: number; undetermined: boolean;
  lines: DiagnosisLine[]; studies: number; missedStudies: number; attribution: Counts;
  singleCauseLines: Record<string, number>; studyRecall: number; hits: number; measuredAt: string;
}
export type DiagnosisRow = Diagnosis | { status: 'no_submission' };
const emptyCounts = (): Counts => ({ single_concept: 0, single_filter: 0, multiple: 0, none: 0, no_lines: 0, undetermined: 0 });

export function classifyLine(block: Pick<FormulaBlock, 'expression'>, negative = false): LineKind {
  return negative || /\[\s*(?:pt|Publication Type|sh|Subheading|dp|Date - Publication|edat|crdt|pdat|la|Language)\s*\]/i.test(block.expression)
    ? 'filter' : 'concept';
}

interface RequiredUnit { id: string; expression: string; negative: boolean }

// 引用符と括弧の外だけを区切り、PubMed の左からの評価順を保つ。
function splitTopLevel(expression: string) {
  const parts: string[] = [];
  const operators: string[] = [];
  let depth = 0, quoted = false, start = 0, outerEnd = -1;
  for (let i = 0; i < expression.length; i++) {
    const char = expression[i];
    if (char === '"') quoted = !quoted;
    if (quoted) continue;
    if (char === '(') depth++;
    if (char === ')') { depth--; if (depth === 0 && outerEnd < 0) outerEnd = i; }
    if (depth < 0) return null;
    if (depth !== 0 || (i > 0 && /[\w#]/.test(expression[i - 1]!))) continue;
    const operator = expression.slice(i).match(/^(AND|OR|NOT)\b/i);
    if (!operator) continue;
    parts.push(expression.slice(start, i).trim());
    operators.push(operator[0].toUpperCase());
    i += operator[0].length - 1;
    start = i + 1;
  }
  parts.push(expression.slice(start).trim());
  if (quoted || depth || parts.some((part) => !part)) return null;
  return { parts, operators, wrapped: expression.startsWith('(') && outerEnd === expression.length - 1 };
}

export function requiredUnits(formula: PubmedFormula) {
  // src/features/validation/expandFormula.ts の chooseEntryBlockId と同じ起点選択。
  const entry = [...formula.blocks].reverse().find((block) => block.isCombination) ?? formula.blocks[formula.blocks.length - 1];
  const byId = new Map(formula.blocks.map((block) => [block.id, block]));
  const used = new Set<string>();
  const pending = entry ? [entry.id] : [];
  while (pending.length) {
    const id = pending.pop()!;
    if (used.has(id)) continue;
    used.add(id);
    for (const ref of byId.get(id)!.expression.matchAll(/#([A-Za-z0-9]+)/g)) {
      if (byId.has(ref[1]!)) pending.push(ref[1]!);
    }
  }
  const units: RequiredUnit[] = [];
  let inline = 0;
  const add = (expression: string, negative: boolean, id?: string) => {
    units.push({ id: id ?? `inline-${++inline}`, negative,
      expression: expression.replace(/#([A-Za-z0-9]+)/g, (_match, ref: string) => `(${expandFormula(formula, ref)})`) });
  };
  const visit = (expression: string, depth: number, root: boolean): boolean => {
    if (depth > 20) return false;
    const parsed = splitTopLevel(expression);
    if (!parsed) return false;
    if (parsed.wrapped) return visit(expression.slice(1, -1).trim(), depth + 1, root);
    if (parsed.operators.includes('OR')) {
      if (root) return false;
      add(expression, false);
      return true;
    }
    if (parsed.operators.length) {
      return parsed.parts.every((part, index) => {
        if (parsed.operators[index - 1] === 'NOT') {
          // 否定の複合式を分割すると除外集合が変わるため、右項全体を測る。
          const ref = part.match(/^#([A-Za-z0-9]+)$/);
          add(part, true, ref?.[1]);
          return true;
        }
        return visit(part, depth + 1, false);
      });
    }
    const ref = expression.match(/^#([A-Za-z0-9]+)$/);
    if (ref) {
      const block = byId.get(ref[1]!);
      if (!block) return false;
      if (block.isCombination) return visit(block.expression, depth + 1, root);
      add(block.expression, false, block.id);
    } else {
      add(expression, false);
    }
    return true;
  };
  const determined = entry ? visit(entry.expression, 0, true) : false;
  return { units: determined ? units : [], undetermined: !determined, unusedLines: formula.blocks.length - used.size };
}

export function countTerms(expression: string) {
  const counts = { meshTerms: 0, freewordTerms: 0, plainTerms: 0 };
  for (const segment of tokenizeExpression(expression)) {
    const tag = segment.text.match(/\[([^\]]+)\]$/);
    if (tag) {
      const kind = classifyFieldTag(tag[1]!.replace(/:~\d+\s*$/, ''));
      if (kind === 'mesh') counts.meshTerms++;
      if (kind === 'freeword') counts.freewordTerms++;
    } else {
      // 引用符内の演算子は語の一部。タグなしの句を一語とし、参照は数えない。
      const parts = segment.text.match(/"[^"]*"|\b(?:AND|OR|NOT)\b|[()]|[^"()]+?(?=\b(?:AND|OR|NOT)\b|["()]|$)/gi) ?? [];
      let phrase = '';
      const flush = () => { if (phrase.replace(/#[A-Za-z0-9]+/g, '').trim()) counts.plainTerms++; phrase = ''; };
      for (const part of parts) {
        if (/^(AND|OR|NOT|\(|\))$/i.test(part)) flush();
        else phrase += part;
      }
      flush();
    }
  }
  return counts;
}

export function attributeStudies(studies: readonly Study[], whole: readonly string[],
  lines: readonly { id: string; kind: DiagnosisLine['kind']; captured: readonly string[] }[], undetermined = false) {
  const captured = (study: Study, reports: readonly string[]) => study.pmids.some((pmid) => reports.includes(pmid));
  const missed = studies.filter((study) => !captured(study, whole));
  const attribution = emptyCounts();
  const singleCauseLines: Record<string, number> = {};
  for (const study of missed) {
    const absent = lines.filter((line) => !captured(study, line.captured));
    const category: Category = undetermined ? 'undetermined' : lines.length <= 1 ? 'no_lines' : !absent.length ? 'none'
      : absent.length > 1 ? 'multiple' : absent[0]!.kind === 'concept' ? 'single_concept' : 'single_filter';
    attribution[category]++;
    if (category === 'single_concept' || category === 'single_filter') {
      const id = absent[0]!.id;
      singleCauseLines[id] = (singleCauseLines[id] ?? 0) + 1;
    }
  }
  return { studies: studies.length, missedStudies: missed.length, attribution, singleCauseLines,
    lineCounts: lines.map((line) => ({ capturedStudies: studies.filter((study) => captured(study, line.captured)).length,
      missedStudies: missed.filter((study) => !captured(study, line.captured)).length })) };
}

export function quantile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  return sorted[lower]! + (sorted[Math.ceil(index)]! - sorted[lower]!) * (index - lower);
}
const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
function lineStatistics(lines: DiagnosisLine[]) {
  const values = (key: 'hits' | 'meshTerms' | 'freewordTerms' | 'plainTerms') => lines.map((line) => line[key]).filter((value): value is number => value !== null);
  const distribution = (key: 'hits' | 'meshTerms' | 'freewordTerms' | 'plainTerms') => ({
    median: quantile(values(key), 0.5), q1: quantile(values(key), 0.25),
    q3: quantile(values(key), 0.75) });
  return { lines: lines.length, hits: distribution('hits'), meshTerms: distribution('meshTerms'),
    freewordTerms: distribution('freewordTerms'), plainTerms: distribution('plainTerms'),
    zeroMeshLines: lines.filter((line) => line.meshTerms === 0).length,
    atMostThreeFreewordLines: lines.filter((line) => line.freewordTerms <= 3).length };
}

export function summarizeDiagnoses(rows: readonly DiagnosisRow[]) {
  const diagnosed = rows.filter((row): row is Diagnosis => row.status === 'diagnosed');
  const concepts = (row: Diagnosis) => row.lines.filter((line) => line.kind === 'concept');
  const group = (runs: Diagnosis[]) => ({ runs: runs.length, meanStudyRecall: mean(runs.map((row) => row.studyRecall)),
    allCapturedRate: mean(runs.map((row) => Number(row.missedStudies === 0))), medianHits: quantile(runs.map((row) => row.hits), 0.5) });
  const determined = diagnosed.filter((row) => !row.undetermined);
  const byConceptCount = [...new Set(determined.map((row) => concepts(row).length))].sort((a, b) => a - b)
    .map((count) => ({ conceptLines: count, ...group(determined.filter((row) => concepts(row).length === count)) }));
  const hasFilter = (row: Diagnosis) => row.lines.some((line) => line.kind === 'filter');
  const missedStudies = diagnosed.reduce((sum, row) => sum + row.missedStudies, 0);
  const attribution = Object.fromEntries(CATEGORIES.map((key) => {
    const studies = diagnosed.reduce((sum, row) => sum + row.attribution[key], 0);
    return [key, { studies, proportion: missedStudies ? studies / missedStudies : null }];
  }));
  const captureGroup = (runs: Diagnosis[]) => ({ runs: runs.length,
    meanConceptLines: mean(runs.map((row) => concepts(row).length)),
    medianFreewordTermsPerLine: quantile(runs.flatMap((row) => concepts(row).map((line) => line.freewordTerms)), 0.5) });
  const worst = diagnosed.flatMap((row) => [...concepts(row)].sort((a, b) => b.missedStudies - a.missedStudies || (a.hits ?? 0) - (b.hits ?? 0)).slice(0, 1));
  return { runs: rows.length, noSubmission: rows.length - diagnosed.length, byConceptCount,
    byConceptCountExcludedRuns: diagnosed.length - determined.length,
    withFilter: group(diagnosed.filter(hasFilter)), withoutFilter: group(diagnosed.filter((row) => !hasFilter(row))),
    missedStudies, attribution, worstConcept: lineStatistics(worst), allConcepts: lineStatistics(diagnosed.flatMap(concepts)),
    allCaptured: captureGroup(diagnosed.filter((row) => row.missedStudies === 0)),
    notAllCaptured: captureGroup(diagnosed.filter((row) => row.missedStudies > 0)) };
}

async function diagnose(args: string[], runtime: RunRuntime): Promise<number> {
  let options;
  try { options = parseRunOptions(args, '--runs'); }
  catch (error) {
    if (error instanceof Error && error.message === '試験群には --open-test-set が必要です') throw new Error('診断は開発群だけ');
    throw error;
  }
  if (!['smoke', 'fixed', 'development'].includes(options.subset)) throw new Error('診断は開発群だけ');
  const reviews = targetReviews(options, runtime);
  const targets = reviews.flatMap((review) => Array.from({ length: options.runsPerReview }, (_, index) => ({ review,
    index: index + 1, dir: runPath(options.root, options.version, review.pmcid, index + 1) })));
  const missing = targets.filter(({ dir }) => !existsSync(dir) || !statSync(dir).isDirectory()).length;
  if (missing) throw new Error(`実行フォルダが ${missing} 件不足しています`);
  const { env, fetchImpl, sleep, now, stdout } = runtime;
  const base = createDeps({ env, fetchImpl, sleep });
  const rows: DiagnosisRow[] = [];
  let failures = 0;
  for (const { review, dir, index } of targets) {
    const info = readRun(dir);
    if (info.version !== options.version || info.pmcid !== review.pmcid || info.runIndex !== index
      || info.cutoffDate !== review.cutoffDate) throw new Error('実行条件が診断対象と一致しません');
    const state = readSubmissionState(dir);
    if (!state.submission) { rows.push({ status: 'no_submission' }); continue; }
    const validated = validateFormulaMd(readFileSync(join(dir, 'submissions', `${state.submission.number}.md`), 'utf8'));
    if (!validated.ok || validated.query !== state.submission.query) throw new Error('提出済みの式が不正です');
    const scorePath = join(dir, 'score.json');
    if (!existsSync(scorePath)) throw new Error('先に採点してください');
    const score = JSON.parse(readFileSync(scorePath, 'utf8')) as StoredScore & { outcome?: SubmissionOutcome };
    if (!scoreMatchesSubmission(score, state) || score.status !== 'scored' || score.outcome?.status !== 'measured') throw new Error('先に採点してください');
    const path = join(dir, 'diagnosis.json');
    if (existsSync(path)) {
      const saved = JSON.parse(readFileSync(path, 'utf8')) as Diagnosis;
      if (saved.status === 'diagnosed' && saved.submission.number === state.fingerprint!.number
        && saved.submission.querySha256 === state.fingerprint!.querySha256
        && typeof saved.scoreMeasuredAt === 'string' && saved.scoreMeasuredAt === score.measuredAt) { rows.push(saved); continue; }
    }
    try {
      const deps = { ...createDeps({ env, fetchImpl, sleep, cutoffDate: info.cutoffDate, timeoutMs: runtime.timeoutMs }), rateLimiter: base.rateLimiter };
      const measured = [];
      const decomposition = requiredUnits(validated.formula);
      for (const unit of decomposition.units) {
        const kind = classifyLine(unit, unit.negative);
        const { count } = await esearch(unit.expression, deps, { retmax: 0 });
        const matches = count ? await capturedGold(unit.expression, review.evaluablePmids, deps) : [];
        if (matches.length > count) throw new Error('捕捉数が総件数を超えています');
        const captured = unit.negative ? review.evaluablePmids.filter((pmid) => !matches.includes(pmid)) : matches;
        measured.push({ id: unit.id, kind, hits: unit.negative ? null : count, captured, ...countTerms(unit.expression) });
      }
      const { lineCounts, ...attribution } = attributeStudies(review.studies, score.outcome.capturedPmids, measured, decomposition.undetermined);
      const lines = measured.map(({ captured: _captured, ...line }, i) => ({ ...line, ...lineCounts[i]! }));
      const row: Diagnosis = { status: 'diagnosed', submission: state.fingerprint!, lines, ...attribution,
        scoreMeasuredAt: score.measuredAt, unusedLines: decomposition.unusedLines, undetermined: decomposition.undetermined,
        studyRecall: score.studyRecall, hits: score.hits, measuredAt: now().toISOString() };
      writeJson(path, row);
      rows.push(row);
    } catch {
      // 式の拒否も通信障害も未測定。応答本文や識別子を出力しない。
      failures++;
    }
  }
  if (failures) { stdout(`診断失敗: ${failures} 件。集計しません\n`); return 1; }
  const report = { version: options.version, subset: options.subset, reviews: reviews.length,
    runsPerReview: options.runsPerReview, generatedAt: now().toISOString(), summary: summarizeDiagnoses(rows) };
  const reportsDir = runtime.reportsDir ?? resolve(__dirname, '../reports');
  mkdirSync(reportsDir, { recursive: true });
  writeJson(join(reportsDir, `diagnose-${options.version}-${options.subset}.json`), report);
  stdout(JSON.stringify(report, null, 2) + '\n');
  return 0;
}

export async function main(args: string[], runtime: RunRuntime = defaultRuntime()): Promise<number> {
  try { return await diagnose(args, runtime); }
  catch (error) { throw new Error(redact(error instanceof Error ? error.message : String(error), [runtime.env.NCBI_API_KEY ?? ''])); }
}
if (require.main === module) {
  config();
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(redact(String(error), [process.env.NCBI_API_KEY ?? '']) + '\n'); process.exitCode = 1;
  });
}
