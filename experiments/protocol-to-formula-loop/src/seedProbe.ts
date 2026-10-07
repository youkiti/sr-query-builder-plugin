import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { config } from 'dotenv';
import { designSpecificQuery, type DesignSpecificQueryInput } from '../../../src/features/formula/skills/designSpecificQuery';
import { SkillResponseError } from '../../../src/features/formula/skills/parseSkillJson';
import type { ChatMessage, LLMProvider } from '../../../src/lib/llm/LLMProvider';
import { esearch, type EutilsDeps } from '../../../src/lib/ncbi/eutils';
import { installDomParser } from '../../query-optimization-bench/domParser';
import { redact } from '../../query-optimization-bench/ncbiEval';
import { loadParsed, resolveBenchDir } from './bench';
import { quantile } from './diagnose';
import type { EvaluableReview } from './evaluable';
import { createDeps, isQueryRejection } from './ncbi';
import { relaxationLadder } from './relaxQuery';
import { readRun, runPath, writeJson } from './runDir';
import { parseRunOptions, targetReviews, type RunRuntime } from './startRuns';
import { validateFormulaMd } from './submission';
import { defaultRuntime } from './tool';

const limits = [5, 10, 20, 50] as const;
const statuses = ['measured', 'zero_hits', 'design_failed', 'rejected'] as const;
type Status = typeof statuses[number];
type Top = `top${typeof limits[number]}`;
interface Counts { goldReports: number; goldStudies: number }
interface RelaxCounts { originalHits: number; listSize: number; levelsUsed: number; levelsRejected: number }
type Result = { status: Status; hits: number; fingerprint: string; measuredAt: string } & Record<Top, Counts> & Partial<RelaxCounts>;
type Input = DesignSpecificQueryInput & { query: string; cutoffDate: string; source: string };
class ProbeError extends Error {}
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
const fileExists = (path: string) => existsSync(path) && statSync(path).isFile();
const provider = (chat: LLMProvider['chat']): LLMProvider => ({ providerId: 'gemini', model: 'recorded', chat });

function parseOptions(args: string[]) {
  const command = args[0], values = new Map<string, string>();
  if (command !== 'prepare' && command !== 'measure') throw new ProbeError('サブコマンドが不正です');
  for (let i = 1; i < args.length; i++) {
    const key = args[i]!;
    if (key === '--subset' && ['validation', 'test'].includes(args[i + 1] ?? '')) {
      throw new ProbeError('シードの下調べは開発群でだけ実行できます');
    }
    if (!['--runs', '--source', '--label', '--subset', ...(command === 'measure' ? ['--relax'] : [])].includes(key) || values.has(key)
      || !args[i + 1] || args[i + 1]!.startsWith('--')) throw new ProbeError('実行引数が不正です');
    values.set(key, args[++i]!);
  }
  const source = values.get('--source'), label = values.get('--label');
  const relax = values.get('--relax');
  if (relax !== undefined && relax !== 'ladder') throw new ProbeError('緩和方法の指定が不正です');
  if (!source || !label || !/^[A-Za-z0-9_-]+$/.test(label)) throw new ProbeError('版または名前の指定が不正です');
  try {
    return { ...parseRunOptions(['--runs', values.get('--runs') ?? '', '--version', source,
      '--subset', values.get('--subset') ?? '', '--runs-per-review', '1'], '--runs'), command, source, label, relax };
  } catch { throw new ProbeError('実行引数が不足しているか不正です'); }
}

async function capturePrompt(input: Input): Promise<string> {
  let messages: readonly ChatMessage[] = [];
  const stop = new Error('指示文を記録しました');
  try {
    await designSpecificQuery(input, provider(async (sent) => { messages = sent; throw stop; }));
  } catch (error) { if (error !== stop) throw error; }
  return messages.map((message) => message.content).join('\n\n---\n\n')
    + '\n\n---\n\n上の指示とスキーマに従い、JSON だけを、このファイルと同じフォルダの `response.json` に書いてください。ほかのファイルは読まず、Web 検索や外部へのアクセスもしないでください。'
    // 以下は、応答をファイルに書かせる都合の注意（製品の API 経由では不要）。無いと、式の中の引用符をエスケープしない応答が出る。
    + '既に response.json があれば上書きします。JSON の文字列の中に二重引用符を書くときは、必ず \\" とエスケープしてください（PubMed の式には二重引用符が多く含まれます）。書いたあとで読み直し、JSON として正しいことを確かめてください。コマンドの実行もしないでください。\n';
}

function readInput(path: string): Input {
  const input = readJson(path) as Input | null;
  if (!input || !['researchQuestion', 'inclusionCriteria', 'exclusionCriteria', 'query', 'cutoffDate', 'source']
    .every((key) => typeof input[key as keyof Input] === 'string')
    || !/^\d{4}-\d{2}-\d{2}$/.test(input.cutoffDate) || !Number.isFinite(Date.parse(input.cutoffDate))
    || (input.studyDesign !== undefined && typeof input.studyDesign !== 'string')
    || !Array.isArray(input.blocks) || input.blocks.some((block) => !block || typeof block.id !== 'string' || typeof block.expression !== 'string')) {
    throw new ProbeError('指示文の入力が不正です');
  }
  return input;
}

function readResult(path: string, fingerprint: string, relax = false): Result | null {
  const value = readJson(path) as Result | null;
  if (value?.fingerprint !== fingerprint) return null;
  const count = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  if (relax && (!count(value.originalHits) || value.originalHits !== value.hits
    || !count(value.listSize) || value.listSize > 50 || value.listSize < Math.min(value.hits, 50)
    || !count(value.levelsUsed) || value.levelsUsed > 4 || !count(value.levelsRejected) || value.levelsRejected > value.levelsUsed
    || (value.status === 'measured' ? value.listSize === 0 : value.listSize !== 0)
    || (['design_failed', 'rejected'].includes(value.status) && (value.hits !== 0 || value.levelsUsed !== 0)))) {
    throw new ProbeError('シードのキャッシュが不正です');
  }
  if (!statuses.includes(value.status) || !count(value.hits)
    || (!relax && (value.status === 'measured' ? value.hits === 0 : value.hits !== 0))
    || typeof value.measuredAt !== 'string' || !Number.isFinite(Date.parse(value.measuredAt))
    || limits.some((k) => {
      const row = value[`top${k}`];
      return !row || !count(row.goldReports) || !count(row.goldStudies) || row.goldReports > Math.min(k, relax ? value.listSize! : value.hits)
        || (row.goldReports === 0 && row.goldStudies !== 0);
    })) throw new ProbeError('シードのキャッシュが不正です');
  return value;
}

async function measure(input: Input, response: string, review: EvaluableReview, deps: EutilsDeps, relax = false) {
  let status: Status = 'design_failed', hits = 0, pmids: string[] = [];
  let levelsUsed = 0, levelsRejected = 0;
  const outcome = () => ({ status, hits, ...topCounts(pmids, review),
    ...(relax ? { originalHits: hits, listSize: pmids.length, levelsUsed, levelsRejected } : {}) });
  let query: string;
  try {
    ({ query } = await designSpecificQuery(input, provider(async () => ({ text: response, tokensIn: null, tokensOut: null, raw: null }))));
  } catch (error) {
    // 記録済み応答の null や不正なプロパティ型も、通信を伴わない設計失敗として数える。
    if (!(error instanceof SkillResponseError) && !(error instanceof TypeError)) throw new ProbeError('絞り込み式の応答の処理に失敗しました（結果不明）');
    return outcome();
  }
  const search = async (query: string) => {
    const result = await esearch(query, deps, { retmax: 50, sort: 'relevance' });
    if (result.pmids.length !== Math.min(result.count, 50) || new Set(result.pmids).size !== result.pmids.length) {
      throw new ProbeError('シードの測定に失敗しました（結果不明）: 検索結果の一覧が不完全です');
    }
    return result;
  };
  try {
    const result = await search(query);
    hits = result.count; pmids = result.pmids; status = hits ? 'measured' : 'zero_hits';
    if (relax) {
      for (const expression of relaxationLadder(query)) {
        if (pmids.length >= 50) break;
        levelsUsed++;
        try {
          const next = await search(expression);
          pmids = [...new Set([...pmids, ...next.pmids])].slice(0, 50);
        } catch (error) {
          if (isQueryRejection(error)) { levelsRejected++; continue; }
          throw error;
        }
      }
      status = pmids.length ? 'measured' : 'zero_hits';
    }
  } catch (error) {
    if (isQueryRejection(error)) status = 'rejected';
    else if (error instanceof ProbeError) throw error;
    else throw new ProbeError('シードの測定に失敗しました（結果不明）: 通信または応答の処理に失敗しました');
  }
  return outcome();
}

function topCounts(pmids: string[], review: EvaluableReview): Record<Top, Counts> {
  return Object.fromEntries(limits.map((k) => {
    const top = new Set(pmids.slice(0, k));
    return [`top${k}`, { goldReports: review.evaluablePmids.filter((pmid) => top.has(pmid)).length,
      goldStudies: review.studies.filter((study) => study.pmids.some((pmid) => top.has(pmid))).length }];
  })) as Record<Top, Counts>;
}
const quantiles = (values: number[]) => ({ min: quantile(values, 0), q1: quantile(values, 0.25),
  median: quantile(values, 0.5), q3: quantile(values, 0.75), max: quantile(values, 1) });
function summarize(results: Result[]) {
  return Object.fromEntries(limits.map((k) => {
    const rows = results.map((result) => result[`top${k}`]);
    const reviewsWithAtLeast1 = rows.filter((row) => row.goldStudies >= 1).length;
    const reviewsWithAtLeast2 = rows.filter((row) => row.goldStudies >= 2).length;
    return [`top${k}`, { goldReportsTotal: rows.reduce((sum, row) => sum + row.goldReports, 0),
      goldStudiesTotal: rows.reduce((sum, row) => sum + row.goldStudies, 0), reviewsWithAtLeast1, reviewsWithAtLeast2,
      reviewsWithAtLeast1Rate: rows.length ? reviewsWithAtLeast1 / rows.length : null,
      reviewsWithAtLeast2Rate: rows.length ? reviewsWithAtLeast2 / rows.length : null,
      goldStudiesQuantiles: quantiles(rows.map((row) => row.goldStudies)) }];
  }));
}

async function seedProbe(args: string[], runtime: RunRuntime): Promise<number> {
  const options = parseOptions(args);
  let reviews: EvaluableReview[];
  try { reviews = targetReviews(options, runtime); }
  catch { throw new ProbeError('対象レビューの記録の読み込みに失敗しました'); }
  const all = reviews.map((review) => ({ review, dir: join(options.root, '_seed-probe', options.label, review.pmcid),
    sourceDir: runPath(options.root, options.source, review.pmcid, 1) }));
  if (options.command === 'prepare') {
    const prepared = all.map((row) => {
      if (!existsSync(row.sourceDir) || !statSync(row.sourceDir).isDirectory() || !fileExists(join(row.sourceDir, 'submission.json'))) return { ...row, submission: null };
      const submission = readJson(join(row.sourceDir, 'submission.json')) as { number: number; query: string } | null;
      if (!submission || !Number.isSafeInteger(submission.number) || submission.number < 1
        || typeof submission.query !== 'string' || !submission.query.trim()) throw new ProbeError('提出の記録が不正です');
      return { ...row, submission: fileExists(join(row.sourceDir, 'submissions', `${submission.number}.md`)) ? submission : null };
    });
    const missing = prepared.filter((row) => !row.submission).length;
    if (missing) throw new ProbeError(`実行フォルダまたは提出が ${missing} 件不足しています`);
    let created = 0, skipped = 0;
    for (const { review, dir, sourceDir, submission } of prepared) {
      if (existsSync(join(dir, 'prompt.md'))) {
        // 同じ名前の下調べを別の版から作り足さない（測定で版が混ざるのを防ぐ）。
        if (readInput(join(dir, 'input.json')).source !== options.source) throw new ProbeError('この名前の下調べは別の版から用意されています');
        skipped++; continue;
      }
      const validated = validateFormulaMd(readFileSync(join(sourceDir, 'submissions', `${submission!.number}.md`), 'utf8'));
      if (!validated.ok || validated.query !== submission!.query) throw new ProbeError('元の提出の式が不正か記録と一致しません');
      const info = readRun(sourceDir);
      if (info.cutoffDate !== review.cutoffDate) throw new ProbeError('元の実行の検索日が対象と一致しません');
      const parsed = loadParsed(resolveBenchDir(runtime.env), review);
      const input: Input = { researchQuestion: `${parsed.title}\n\n${parsed.objectives}`,
        inclusionCriteria: ['types_of_studies', 'types_of_participants', 'types_of_interventions', 'types_of_outcomes']
          .map((field) => `## ${field}\n${parsed.eligibility[field] ?? ''}`).join('\n\n'),
        exclusionCriteria: '', studyDesign: parsed.eligibility.types_of_studies ?? '',
        blocks: validated.formula.blocks.filter((block) => !block.isCombination).map(({ id, expression }) => ({ id, expression })),
        query: submission!.query, cutoffDate: info.cutoffDate, source: options.source };
      const prompt = await capturePrompt(input);
      mkdirSync(dir, { recursive: true });
      writeJson(join(dir, 'input.json'), input); writeFileSync(join(dir, 'prompt.md'), prompt); created++;
    }
    runtime.stdout(`用意した指示文: 新規 ${created} 件、既にあり飛ばした ${skipped} 件\n`);
    return 0;
  }
  const missing = all.filter(({ dir }) => !fileExists(join(dir, 'input.json')) || !fileExists(join(dir, 'response.json'))).length;
  if (missing) throw new ProbeError(`指示文または応答が ${missing} 件不足しています`);
  const { env, fetchImpl, sleep, now, stdout } = runtime;
  const base = createDeps({ env, fetchImpl, sleep, rateLimiter: runtime.rateLimiter });
  const records: { studyCount: number; result: Result }[] = [];
  let measured = 0, cached = 0, remeasured = 0;
  for (const { review, dir } of all) {
    const input = readInput(join(dir, 'input.json')), response = readFileSync(join(dir, 'response.json'), 'utf8');
    if (input.source !== options.source) throw new ProbeError('この名前の下調べは別の版から用意されています');
    // 用意したあとでベンチの検索日が変わっていたら、古い日付で測らずに用意し直しを求める。
    if (input.cutoffDate !== review.cutoffDate) throw new ProbeError('用意した指示文の検索日が現在の対象と一致しません（用意し直してください）');
    const fingerprint = createHash('sha256').update([options.relax ? 'seed-probe-relax-ladder-v1' : 'seed-probe-v1', response, input.cutoffDate,
      [...review.evaluablePmids].sort().join('\n'), review.studies.map((study) => JSON.stringify([study.id, [...study.pmids].sort()])).sort().join('\n')].join('\n')).digest('hex');
    const path = join(dir, options.relax ? 'result-relax-ladder.json' : 'result.json'), existed = existsSync(path), saved = existed ? readResult(path, fingerprint, !!options.relax) : null;
    let result: Result;
    if (saved) { result = saved; cached++; }
    else {
      const deps = createDeps({ env, fetchImpl, sleep, cutoffDate: input.cutoffDate, rateLimiter: base.rateLimiter, timeoutMs: runtime.timeoutMs });
      result = { ...await measure(input, response, review, deps, !!options.relax), fingerprint, measuredAt: now().toISOString() };
      writeJson(path, result);
      if (existed) remeasured++; else measured++;
    }
    records.push({ studyCount: review.studies.length, result });
  }
  const results = records.map((row) => row.result), dates = results.map((row) => row.measuredAt).sort((a, b) => Date.parse(a) - Date.parse(b));
  const states = Object.fromEntries(statuses.map((status) => [status, results.filter((row) => row.status === status).length]));
  const byStudyCount = Object.fromEntries(['1-3', '4-10', '11+'].map((band, index) => {
    const selected = records.filter(({ studyCount }) => index === 0 ? studyCount <= 3 : index === 1 ? studyCount >= 4 && studyCount <= 10 : studyCount >= 11);
    return [band, { reviews: selected.length, ...summarize(selected.map((row) => row.result)) }];
  }));
  const reportsDir = runtime.reportsDir ?? resolve(__dirname, '../reports');
  const originalZero = results.filter((row) => ['measured', 'zero_hits'].includes(row.status) && row.originalHits === 0);
  const relaxed = { relax: 'ladder', listSizeQuantiles: quantiles(results.map((row) => row.listSize ?? 0)),
    reviewsRelaxed: results.filter((row) => (row.levelsUsed ?? 0) > 0).length,
    levelsUsedTotal: results.reduce((sum, row) => sum + (row.levelsUsed ?? 0), 0),
    levelsRejectedTotal: results.reduce((sum, row) => sum + (row.levelsRejected ?? 0), 0),
    reviewsOriginalZero: originalZero.length, reviewsOriginalZeroRecovered: originalZero.filter((row) => row.listSize! > 0).length };
  mkdirSync(reportsDir, { recursive: true });
  writeJson(join(reportsDir, `seed-probe-${options.label}${options.relax ? '-relax-ladder' : ''}-${options.subset}.json`), {
    source: options.source, label: options.label, subset: options.subset, reviews: reviews.length, generatedAt: now().toISOString(),
    measuredFrom: dates[0] ?? null, measuredTo: dates[dates.length - 1] ?? null, states,
    hitsQuantiles: quantiles(results.filter((row) => row.status === 'measured').map((row) => row.hits)), ...summarize(results), byStudyCount,
    ...(options.relax ? relaxed : {}),
  });
  stdout(`対象のレビュー: ${reviews.length} 件\n`);
  stdout(`測ったレビュー: 新規 ${measured} 件、保存済み ${cached} 件、測り直し ${remeasured} 件\n`);
  stdout(`状態: ${statuses.map((status) => `${status} ${states[status]} 件`).join('、')}\n`);
  if (options.relax) stdout(`ゆるめたレビュー: ${relaxed.reviewsRelaxed} 件、元の式が 0 件: ${relaxed.reviewsOriginalZero} 件（うち候補を補えた ${relaxed.reviewsOriginalZeroRecovered} 件）\n`);
  return 0;
}

export async function main(args: string[], runtime: RunRuntime = defaultRuntime()): Promise<number> {
  try { return await seedProbe(args, runtime); }
  catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException)?.code) throw new Error('シードの下調べのファイルの読み書きに失敗しました');
    if (error instanceof ProbeError) throw error;
    throw new Error('シードの下調べの処理に失敗しました');
  }
}
if (require.main === module) {
  installDomParser();
  config();
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(redact(String(error), [process.env.NCBI_API_KEY ?? '']) + '\n'); process.exitCode = 1;
  });
}
