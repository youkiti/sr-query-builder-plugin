import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { config } from 'dotenv';
import { installDomParser } from '../../query-optimization-bench/domParser';
import { capturedGold, redact, seedTitles } from '../../query-optimization-bench/ncbiEval';
import { originalFormulaOutcome } from './baseline';
import type { Study } from './bench';
import { loadConditions } from './conditions';
import { attributeStudies, countTerms, quantile } from './diagnose';
import type { EvaluableReview } from './evaluable';
import { classifyLine, requiredUnits } from './formulaUnits';
import type { SubmissionOutcome } from './metrics';
import { createDeps, isQueryRejection } from './ncbi';
import { originalRequiredParts, stripDateRange } from './originalParts';
import { readRun, runPath, writeJson } from './runDir';
import { readSubmissionState, scoreMatchesSubmission, type StoredScore } from './scoreRuns';
import { parseRunOptions, targetReviews, type RunRuntime } from './startRuns';
import { validateFormulaMd } from './submission';
import { defaultRuntime } from './tool';

class DiffError extends Error {}
const categories = ['single_concept', 'single_filter', 'multiple', 'none', 'no_lines'] as const;
type Category = typeof categories[number];
interface Part {
  id: string; expression: string; negative: boolean; kind: 'concept' | 'filter'; captured: string[] | null;
}
interface Formula { determined: boolean; excluded: boolean; parts: Part[]; text: string }
type Cached = { fingerprint: string; measuredAt: string } &
  ({ status: 'measured'; capturedPmids: string[] } | { status: 'rejected' });

function parseOptions(args: string[]) {
  if (args.includes('--open-test-set') || args.some((arg, i) => arg === '--subset' && ['validation', 'test'].includes(args[i + 1] ?? ''))) {
    throw new DiffError('原著式との比較は開発群でだけ実行できます');
  }
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (!['--runs', '--subset', '--bundle', '--bundle-runs', '--label'].includes(key)
      || values.has(key) || !args[i + 1] || args[i + 1]!.startsWith('--')) throw new DiffError('実行引数が不正です');
    values.set(key, args[++i]!);
  }
  const bundle = values.get('--bundle') ?? '', label = values.get('--label') ?? '';
  if (![bundle, label].every((value) => /^[A-Za-z0-9_-]+$/.test(value))) throw new DiffError('実行引数が不正です');
  try {
    return { ...parseRunOptions(['--runs', values.get('--runs') ?? '', '--subset', values.get('--subset') ?? '',
      '--version', bundle, '--runs-per-review', values.get('--bundle-runs') ?? ''], '--runs'), bundle, label };
  } catch { throw new DiffError('実行引数が不正です'); }
}

const captured = (study: Study, pmids: readonly string[]) => study.pmids.some((pmid) => pmids.includes(pmid));
const distribution = (values: number[]) => ({ min: quantile(values, 0), q1: quantile(values, 0.25),
  median: quantile(values, 0.5), q3: quantile(values, 0.75), max: quantile(values, 1) });

function structure() {
  return { formulas: 0, undetermined: 0, conceptCounts: { '0': 0, '1': 0, '2': 0, '3': 0, '4+': 0 },
    withFilter: 0, withNegative: 0, meshTerms: [] as number[], freewordTerms: [] as number[], plainTerms: [] as number[], recalls: [] as number[] };
}
function addStructure(summary: ReturnType<typeof structure>, formula: Formula, studies: Study[]) {
  summary.formulas++;
  if (!formula.determined) { summary.undetermined++; return; }
  const concepts = formula.parts.filter((part) => part.kind === 'concept');
  const key = concepts.length >= 4 ? '4+' : String(concepts.length) as '0' | '1' | '2' | '3';
  summary.conceptCounts[key]++;
  summary.withFilter += Number(formula.parts.some((part) => part.kind === 'filter'));
  summary.withNegative += Number(formula.parts.some((part) => part.negative));
  for (const part of concepts) {
    const terms = countTerms(part.expression);
    for (const key of ['meshTerms', 'freewordTerms', 'plainTerms'] as const) summary[key].push(terms[key]);
    if (part.captured !== null && studies.length) summary.recalls.push(studies.filter((study) => captured(study, part.captured!)).length / studies.length);
  }
}
function summarizeStructure(summary: ReturnType<typeof structure>) {
  const determined = summary.formulas - summary.undetermined;
  return { formulas: summary.formulas, undetermined: summary.undetermined, determined, conceptCounts: summary.conceptCounts,
    withFilter: summary.withFilter, withNegative: summary.withNegative,
    filterRate: determined ? summary.withFilter / determined : null, negativeRate: determined ? summary.withNegative / determined : null,
    meshTerms: distribution(summary.meshTerms), freewordTerms: distribution(summary.freewordTerms), plainTerms: distribution(summary.plainTerms),
    conceptRecall: distribution(summary.recalls), measuredConcepts: summary.recalls.length };
}
function attribution() {
  return { pairs: { single_concept: 0, single_filter: 0, multiple: 0, none: 0, no_lines: 0, excluded: 0 },
    studies: { all_single_concept: 0, all_single_filter: 0, all_multiple: 0, mixed: 0, incomplete: 0 } };
}
function classify(study: Study, formula: Formula): { category: Category | 'excluded'; missing: string[] } {
  if (formula.excluded) return { category: 'excluded', missing: [] };
  const lines = formula.parts.map((part) => ({ ...part, captured: part.captured! }));
  const counts = attributeStudies([study], [], lines).attribution;
  return { category: categories.find((category) => counts[category])!,
    missing: lines.filter((line) => !captured(study, line.captured)).map((line) => line.id) };
}
function addAttribution(summary: ReturnType<typeof attribution>, studies: Study[], formulas: Formula[]) {
  for (const study of studies) {
    const results = formulas.map((formula) => classify(study, formula).category);
    for (const category of results) summary.pairs[category]++;
    const type = !results.length || results.includes('excluded') ? 'incomplete'
      : results.every((category) => category === 'single_concept') ? 'all_single_concept'
        : results.every((category) => category === 'single_filter') ? 'all_single_filter'
          : results.every((category) => category === 'multiple') ? 'all_multiple' : 'mixed';
    summary.studies[type]++;
  }
}

async function originalDiff(args: string[], runtime: RunRuntime): Promise<number> {
  const options = parseOptions(args);
  let combine;
  try { combine = loadConditions(options.bundle, runtime.harnessDir).combine; }
  catch { throw new DiffError('束ねた版の条件を読み込めません'); }
  if (!combine || !('from' in combine) || 'blocks' in combine) throw new DiffError('束ねた版には元の版と本数だけの条件が必要です');
  const { from, k } = combine;
  if (!Number.isSafeInteger(options.runsPerReview * k)) throw new DiffError('実行引数が不正です');
  let reviews: EvaluableReview[];
  try { reviews = targetReviews(options, runtime); }
  catch { throw new DiffError('対象レビューの記録の読み込みに失敗しました'); }
  let missing = 0;
  const prepared = reviews.map((review) => {
    const bundles = Array.from({ length: options.runsPerReview }, (_, i) => {
      try {
        const dir = runPath(options.root, options.bundle, review.pmcid, i + 1);
        const score = JSON.parse(readFileSync(join(dir, 'score.json'), 'utf8')) as StoredScore & { outcome?: SubmissionOutcome };
        if (!score || !scoreMatchesSubmission(score, readSubmissionState(dir))) throw new Error();
        const outcome = score.outcome;
        if (outcome?.status === 'no_submission' || outcome?.status === 'invalid_submission') return { capturedPmids: [], hits: 0 };
        if (outcome?.status !== 'measured' || !Array.isArray(outcome.capturedPmids)
          || outcome.capturedPmids.some((pmid) => typeof pmid !== 'string') || !Number.isSafeInteger(outcome.hits) || outcome.hits < 0) throw new Error();
        return { capturedPmids: outcome.capturedPmids.filter((pmid) => review.evaluablePmids.includes(pmid)), hits: outcome.hits };
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        missing++; return { capturedPmids: [], hits: 0 };
      }
    });
    const sources = Array.from({ length: options.runsPerReview * k }, (_, i): Formula => {
      try {
        const dir = runPath(options.root, from, review.pmcid, i + 1), state = readSubmissionState(dir);
        if (!state.submission || !Number.isSafeInteger(state.submission.number) || state.submission.number < 1) throw new Error();
        const text = readFileSync(join(dir, 'submissions', `${state.submission.number}.md`), 'utf8');
        const validated = validateFormulaMd(text), info = readRun(dir);
        if (!validated.ok || validated.query !== state.submission.query || info.cutoffDate !== review.cutoffDate
          || info.pmcid !== review.pmcid || info.version !== from || info.runIndex !== i + 1) throw new Error();
        const result = requiredUnits(validated.formula);
        return { text, determined: !result.undetermined, excluded: result.undetermined,
          parts: result.units.map((unit) => ({ ...unit, kind: classifyLine(unit, unit.negative), captured: null })) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        missing++; return { text: '', determined: false, excluded: true, parts: [] };
      }
    });
    return { review, bundles, sources };
  });
  if (missing) throw new DiffError(`採点記録または提出が ${missing} 件不足しています`);
  const { env, fetchImpl, sleep, now, stdout } = runtime;
  const base = createDeps({ env, fetchImpl, sleep, rateLimiter: runtime.rateLimiter });
  const exclusions = { undeterminedRuns: 0, undeterminedElements: 0, unmeasurableParts: 0, rejectedUnits: 0, excludedRuns: 0, excludedElements: 0 };
  const aiStructure = structure(), originalStructure = structure(), originalOnly = attribution(), bundleOnly = attribution();
  const translators: Record<string, number> = Object.create(null) as Record<string, number>;
  const ratios: number[] = [], dates: string[] = [], readings: { pmcid: string; text: string }[] = [];
  let measured = 0, cached = 0;
  for (const { review, bundles, sources } of prepared) {
    if (!/^PMC\d+$/.test(review.pmcid)) throw new DiffError('対象レビューの識別子が不正です');
    const deps = createDeps({ env, fetchImpl, sleep, cutoffDate: review.cutoffDate, rateLimiter: base.rateLimiter, timeoutMs: runtime.timeoutMs });
    const measure = async (formula: Formula, original: boolean) => {
      for (const part of formula.parts) {
        if (original && part.expression.length > 20_000) { exclusions.unmeasurableParts++; formula.excluded = true; continue; }
        const fingerprint = createHash('sha256').update([review.cutoffDate, part.expression, [...review.evaluablePmids].sort().join('\n')].join('\n')).digest('hex');
        const path = join(options.root, '_cache', 'original-diff', `${fingerprint}.json`);
        let result: Cached;
        if (existsSync(path)) {
          result = JSON.parse(readFileSync(path, 'utf8')) as Cached;
          if (!result || result.fingerprint !== fingerprint || typeof result.measuredAt !== 'string' || !Number.isFinite(Date.parse(result.measuredAt))
            || (result.status !== 'rejected' && (result.status !== 'measured' || !Array.isArray(result.capturedPmids)
              || result.capturedPmids.some((pmid) => !review.evaluablePmids.includes(pmid))
              || new Set(result.capturedPmids).size !== result.capturedPmids.length))) throw new DiffError('単位のキャッシュが不正です');
          cached++;
        } else {
          try { result = { status: 'measured', capturedPmids: await capturedGold(part.expression, review.evaluablePmids, deps), fingerprint, measuredAt: now().toISOString() }; }
          catch (error) {
            if (!isQueryRejection(error)) throw new DiffError('単位の測定に失敗しました（結果不明）');
            result = { status: 'rejected', fingerprint, measuredAt: now().toISOString() };
          }
          mkdirSync(dirname(path), { recursive: true }); writeJson(path, result); measured++;
        }
        dates.push(result.measuredAt);
        if (result.status === 'rejected') { exclusions.rejectedUnits++; formula.excluded = true; }
        else part.captured = part.negative ? review.evaluablePmids.filter((pmid) => !result.capturedPmids.includes(pmid)) : result.capturedPmids;
      }
    };
    const originals: Formula[] = [];
    for (const unit of review.units ?? []) {
      translators[unit.translator] = (translators[unit.translator] ?? 0) + 1;
      const inner = stripDateRange(unit.query), parsed = inner === null ? { determined: false, parts: [] } : originalRequiredParts(inner);
      const formula: Formula = { determined: parsed.determined, excluded: !parsed.determined, text: '',
        parts: parsed.parts.map((part, i) => ({ ...part, id: String(i + 1), captured: null })) };
      if (!parsed.determined) exclusions.undeterminedElements++;
      await measure(formula, true);
      exclusions.excludedElements += Number(formula.excluded);
      if (formula.determined) addStructure(originalStructure, formula, review.studies);
      originals.push(formula);
    }
    for (const formula of sources) {
      exclusions.undeterminedRuns += Number(!formula.determined);
      await measure(formula, false);
      exclusions.excludedRuns += Number(formula.excluded);
      addStructure(aiStructure, formula, review.studies);
    }
    if (review.n_records > 0) ratios.push(quantile(bundles.map((bundle) => bundle.hits), 0.5)! / review.n_records);
    const originalPmids = originalFormulaOutcome(review).capturedPmids.filter((pmid) => review.evaluablePmids.includes(pmid));
    const differences = bundles.map((bundle, i) => {
      const left = review.studies.filter((study) => captured(study, originalPmids) && !captured(study, bundle.capturedPmids));
      const right = review.studies.filter((study) => !captured(study, originalPmids) && captured(study, bundle.capturedPmids));
      addAttribution(originalOnly, left, sources.slice(i * k, (i + 1) * k));
      addAttribution(bundleOnly, right, originals);
      const both = review.studies.filter((study) => captured(study, originalPmids) && captured(study, bundle.capturedPmids)).length;
      return { left, right, both, neither: review.studies.length - both - left.length - right.length };
    });
    const lines = [`# ${review.pmcid}`, `研究数: ${review.studies.length}`];
    differences.forEach((difference, i) => lines.push(`回 ${i + 1}: 両方 ${difference.both}、原著だけ ${difference.left.length}、束ねた版だけ ${difference.right.length}、どちらも拾えず ${difference.neither}`));
    const partText = (part: Part) => `単位 ${part.id}: ${part.kind}${part.negative ? '（否定）' : ''}、拾った研究数: ${part.captured === null ? '未測定' : review.studies.filter((study) => captured(study, part.captured!)).length}`;
    originals.forEach((formula, i) => {
      const unit = review.units![i]!;
      lines.push(`\n## 原著の要素 ${i + 1}`, `翻訳器: ${unit.translator}、件数: ${unit.count}、帰属: ${formula.excluded ? '対象外' : '対象'}`);
      if (!formula.determined) lines.push('分解できない要素');
      formula.parts.forEach((part) => lines.push(partText(part), '```', part.expression.slice(0, 6000), '```'));
    });
    sources.forEach((formula, i) => lines.push(`\n## AI の実行 ${i + 1}`, formula.text,
      `帰属: ${formula.excluded ? '対象外' : '対象'}`, ...formula.parts.map(partText)));
    const first = differences[0]!;
    const sample = [...first.left.slice(0, 15), ...first.right.slice(0, 15)];
    const titlePmids = [...new Set(sample.flatMap((study) => study.pmids.filter((pmid) => review.evaluablePmids.includes(pmid))))];
    let titles = new Map<string, string | null>();
    if (titlePmids.length) {
      try { titles = new Map((await seedTitles(titlePmids, deps)).map((entry) => [entry.pmid, entry.title])); }
      catch { /* 題だけは取得できなくても帰属を残す。 */ }
    }
    const examples = (heading: string, studies: Study[], formulas: Formula[]) => {
      lines.push(`\n## ${heading}（回 1・最大 15 研究）`);
      for (const study of studies.slice(0, 15)) {
        lines.push(`研究: ${study.id}`);
        for (const pmid of study.pmids.filter((pmid) => review.evaluablePmids.includes(pmid))) lines.push(`PMID: ${pmid}、題: ${titles.get(pmid) ?? ''}`);
        formulas.forEach((formula, i) => { const result = classify(study, formula); lines.push(`${i + 1}: ${result.category}、拾えていない単位: ${result.missing.join(', ')}`); });
      }
    };
    examples('原著式だけが拾った研究', first.left, sources.slice(0, k));
    examples('束ねた版だけが拾った研究', first.right, originals);
    readings.push({ pmcid: review.pmcid, text: lines.join('\n\n') + '\n' });
  }
  dates.sort((a, b) => Date.parse(a) - Date.parse(b));
  const report = { bundle: options.bundle, subset: options.subset, bundleRuns: options.runsPerReview, label: options.label, source: from, k,
    reviews: reviews.length, generatedAt: now().toISOString(), measuredFrom: dates[0] ?? null, measuredTo: dates[dates.length - 1] ?? null,
    measurements: { measured, cached }, translators, exclusions,
    structure: { ai: summarizeStructure(aiStructure), original: summarizeStructure(originalStructure), hitsRatio: distribution(ratios) }, originalOnly, bundleOnly };
  const readingDir = join(options.root, '_original-diff', options.label), reportsDir = runtime.reportsDir ?? resolve(__dirname, '../reports');
  mkdirSync(readingDir, { recursive: true }); mkdirSync(reportsDir, { recursive: true });
  for (const reading of readings) writeFileSync(join(readingDir, `${reading.pmcid}.md`), redact(reading.text, [env.NCBI_API_KEY ?? '']));
  writeJson(join(reportsDir, `original-diff-${options.bundle}-${options.subset}.json`), report);
  stdout(`対象のレビュー: ${reviews.length} 件\n`);
  stdout(`測定: 新規 ${measured} 回、保存済み ${cached} 回\n`);
  stdout(`分解できない実行: ${exclusions.undeterminedRuns} 件、分解できない要素: ${exclusions.undeterminedElements} 件、測れない部分: ${exclusions.unmeasurableParts} 件、拒否された単位: ${exclusions.rejectedUnits} 件\n`);
  stdout(`読み物: ${readings.length} 件\n`);
  return 0;
}

export async function main(args: string[], runtime: RunRuntime = defaultRuntime()): Promise<number> {
  try { return await originalDiff(args, runtime); }
  catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException)?.code) throw new Error('原著式との比較のファイルの読み書きに失敗しました');
    if (error instanceof DiffError) throw new Error(redact(error.message, [runtime.env.NCBI_API_KEY ?? '']));
    throw new Error('原著式との比較の処理に失敗しました');
  }
}
if (require.main === module) {
  installDomParser();
  config();
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(redact(String(error), [process.env.NCBI_API_KEY ?? '']) + '\n'); process.exitCode = 1;
  });
}
