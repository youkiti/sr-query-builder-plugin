import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { config } from 'dotenv';
import { efetchArticles, esearch, EutilsError, EUTILS_DEFAULT_MAX_RETRIES, resolveRateLimiter, shouldRetryEutils, type EutilsDeps } from '../../../src/lib/ncbi/eutils';
import { retryWithBackoff } from '../../../src/lib/ncbi/rateLimit';
import { installDomParser } from '../../query-optimization-bench/domParser';
import { capturedGold, redact } from '../../query-optimization-bench/ncbiEval';
import { loadConditions } from './conditions';
import { quantile } from './diagnose';
import { classifyLine, requiredUnits } from './formulaUnits';
import type { SubmissionOutcome } from './metrics';
import { createDeps, isQueryRejection } from './ncbi';
import { diversify, outsideQueries } from './outsideSample';
import { readRun, runPath, writeJson } from './runDir';
import { readSubmissionState, scoreMatchesSubmission, type StoredScore } from './scoreRuns';
import { parseRunOptions, targetReviews, type RunRuntime } from './startRuns';
import { validateFormulaMd } from './submission';
import { defaultRuntime } from './tool';

const methods = ['current', 'narrowed', 'narrowed_diverse', 'beyond_bundle_diverse'] as const;
type Method = typeof methods[number];
interface Counts { sampleSize: number; sampleGold: number; poolHits: number; poolGold: number }
type Result = { status: 'rejected' } | { status: 'measured'; missedGold: number; methods: Record<Method, Counts> };
type CachedResult = Result & { fingerprint: string; measuredAt: string };

export function parseSampleOptions(args: string[]) {
  const remaining: string[] = [], versions = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (key === '--subset' && ['validation', 'test'].includes(args[i + 1] ?? '')) {
      throw new Error('見本の下調べは開発群でだけ実行できます');
    }
    if (key === '--open-test-set' || key === '--version') throw new Error('実行引数が不正です');
    if (key !== '--source' && key !== '--bundle') { remaining.push(key); continue; }
    if (versions.has(key) || !/^[A-Za-z0-9_-]+$/.test(args[i + 1] ?? '')) throw new Error('版の指定が不正です');
    versions.set(key, args[++i]!);
  }
  const source = versions.get('--source'), bundle = versions.get('--bundle');
  if (!source || !bundle) throw new Error('版の指定が不足しています');
  return { ...parseRunOptions([...remaining, '--version', source], '--runs'), source, bundle };
}

function readJson(path: string): unknown { return JSON.parse(readFileSync(path, 'utf8')); }
function readSubmission(dir: string): { number: number; query: string } {
  const value = readJson(join(dir, 'submission.json')) as { number: number; query: string } | null;
  if (!value || !Number.isSafeInteger(value.number) || value.number < 1 || typeof value.query !== 'string' || !value.query.trim()) {
    throw new Error('提出の記録が不正です');
  }
  return value;
}
function readResult(path: string, fingerprint: string): CachedResult | null {
  const value = readJson(path) as CachedResult | null;
  if (value?.fingerprint !== fingerprint) return null;
  if (typeof value.measuredAt !== 'string' || !Number.isFinite(Date.parse(value.measuredAt))) throw new Error('見本のキャッシュが不正です');
  const count = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  if (value?.status === 'rejected') return value;
  if (value?.status !== 'measured' || !count(value.missedGold) || methods.some((method) => {
    const row = value.methods?.[method];
    return !row || ![row.sampleSize, row.sampleGold, row.poolHits, row.poolGold].every(count)
      || row.sampleSize > 15 || row.sampleGold > row.sampleSize || row.poolGold > row.poolHits || row.sampleSize > row.poolHits;
  })) throw new Error('見本のキャッシュが不正です');
  return value;
}

// 論文として返らない PMID は、書籍の記録を確認できた場合だけ MeSH なしとして扱う。
async function fetchBookPmids(pmids: string[], deps: EutilsDeps): Promise<Set<string>> {
  const params = new URLSearchParams({ db: 'pubmed', retmode: 'xml', id: pmids.join(','), tool: deps.tool ?? 'sr-query-builder-plugin' });
  if (deps.apiKey) params.set('api_key', deps.apiKey);
  if (deps.email) params.set('email', deps.email);
  const rateLimiter = resolveRateLimiter(deps);
  const xml = await retryWithBackoff(async () => {
    await rateLimiter.acquire();
    const response = await deps.fetch(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?${params.toString()}`);
    if (!response.ok) throw new EutilsError(`efetch failed: HTTP ${response.status}`, response.status);
    return await response.text();
  }, { sleep: deps.sleep, maxRetries: deps.maxRetries ?? EUTILS_DEFAULT_MAX_RETRIES, shouldRetry: shouldRetryEutils });
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  if (doc.getElementsByTagName('parsererror').length || doc.getElementsByTagName('ERROR').length) {
    throw new Error('書誌の取得件数が一致しません');
  }
  return new Set(Array.from(doc.getElementsByTagName('PubmedBookArticle')).flatMap((article) =>
    Array.from(article.getElementsByTagName('BookDocument')).flatMap((book) => Array.from(book.children)
      .filter((child) => child.tagName === 'PMID').map((child) => child.textContent?.trim() ?? ''))));
}
async function diverseSample(pmids: string[], deps: EutilsDeps): Promise<string[]> {
  const headings = new Map<string, string[]>();
  for (let offset = 0; offset < pmids.length; offset += 100) {
    const chunk = pmids.slice(offset, offset + 100);
    const fetchChunk = async (ids: string[]) => {
      const articles = await efetchArticles(ids, deps);
      if (new Set(articles.map((article) => article.pmid)).size !== articles.length
        || articles.some((article) => !ids.includes(article.pmid))) throw new Error('書誌の取得件数が一致しません');
      for (const article of articles) headings.set(article.pmid, article.meshDetails.filter((heading) => heading.majorTopic).map((heading) => heading.descriptor));
    };
    await fetchChunk(chunk);
    const missing = chunk.filter((pmid) => !headings.has(pmid));
    if (missing.length) {
      const books = await fetchBookPmids(missing, deps);
      if (missing.some((pmid) => !books.has(pmid))) throw new Error('書誌の取得件数が一致しません');
      for (const pmid of missing) headings.set(pmid, []);
    }
  }
  return diversify(pmids.map((pmid) => ({ pmid, majorHeadings: headings.get(pmid)! })), 15);
}

async function measure(queries: NonNullable<ReturnType<typeof outsideQueries>>, gold: string[], missedGold: number, deps: EutilsDeps): Promise<Result> {
  const pool = async (query: string, retmax: number) => {
    const result = await esearch(query, deps, { retmax, sort: 'relevance' });
    if (result.pmids.length !== Math.min(result.count, retmax) || new Set(result.pmids).size !== result.pmids.length) {
      throw new Error('検索結果の一覧が不完全です');
    }
    const poolGold = result.count ? (await capturedGold(query, gold, deps)).length : 0;
    if (poolGold > result.count) throw new Error('捕捉数が総件数を超えています');
    return { ...result, poolGold };
  };
  const current = await pool(queries.current, 15), narrowed = await pool(queries.narrowed, 200);
  const diverse = await diverseSample(narrowed.pmids, deps);
  const beyond = await pool(queries.narrowedBeyondBundle, 200);
  const beyondDiverse = await diverseSample(beyond.pmids, deps);
  const counts = (result: Awaited<ReturnType<typeof pool>>, sample: string[]): Counts => ({
    sampleSize: sample.length, sampleGold: sample.filter((pmid) => gold.includes(pmid)).length,
    poolHits: result.count, poolGold: result.poolGold,
  });
  return { status: 'measured', missedGold, methods: {
    current: counts(current, current.pmids), narrowed: counts(narrowed, narrowed.pmids.slice(0, 15)),
    narrowed_diverse: counts(narrowed, diverse), beyond_bundle_diverse: counts(beyond, beyondDiverse),
  } };
}

function safeCause(error: unknown, apiKey: string): string {
  const message = redact(error instanceof Error ? error.message : String(error), [apiKey]);
  // 外部の応答本文や URL は式・識別子を含み得るので、既知の原因だけを公開する。
  if (['書誌の取得件数が一致しません', '検索結果の一覧が不完全です', '捕捉数が総件数を超えています',
    '捕捉 PMID が欠落しているか、要求した gold と一致しません'].includes(message)) return message;
  const http = message.match(/^(?:esearch|efetch) failed: HTTP (\d{3})$/);
  if (http) return `通信先の HTTP エラー（${http[1]}）`;
  return '通信または応答の処理に失敗しました';
}

async function sampleYield(args: string[], runtime: RunRuntime): Promise<number> {
  const options = parseSampleOptions(args), conditions = loadConditions(options.bundle, runtime.harnessDir);
  if (!conditions.combine || !('from' in conditions.combine) || conditions.combine.from !== options.source) {
    throw new Error('束ねた版の条件が元の版と一致しません');
  }
  const { k } = conditions.combine;
  let reviews: ReturnType<typeof targetReviews>;
  try { reviews = targetReviews(options, runtime); }
  catch { throw new Error('対象レビューの記録の読み込みに失敗しました'); }
  const all = reviews.flatMap((review) => Array.from({ length: options.runsPerReview }, (_, i) => ({ review, runIndex: i + 1,
    sourceDir: runPath(options.root, options.source, review.pmcid, i * k + 1),
    bundleDir: runPath(options.root, options.bundle, review.pmcid, i + 1) })));
  let missing = 0;
  const prepared = all.map((run) => {
    for (const dir of [run.sourceDir, run.bundleDir]) {
      const available = existsSync(dir) && statSync(dir).isDirectory() && existsSync(join(dir, 'submission.json'));
      const scorePath = join(dir, 'score.json');
      if (!available || (dir === run.sourceDir && !existsSync(scorePath))) { missing++; continue; }
      if (dir === run.sourceDir) {
        const saved = readJson(scorePath) as StoredScore & { outcome?: SubmissionOutcome };
        const state = readSubmissionState(dir);
        if (!saved || !scoreMatchesSubmission(saved, state) || saved.status !== 'scored' || saved.outcome?.status !== 'measured') missing++;
      }
    }
    return run;
  });
  if (missing) throw new Error(`実行フォルダまたは提出が ${missing} 件不足しています`);
  const { env, fetchImpl, sleep, now, stdout } = runtime;
  const base = createDeps({ env, fetchImpl, sleep, rateLimiter: runtime.rateLimiter });
  let measured = 0, cached = 0, remeasured = 0, skippedTargets = 0, rejectedTargets = 0;
  const measuredDates: string[] = [], runMissed = new Map<string, number>();
  const skippedRuns = { undetermined: 0 };
  const records: { review: string; result: Extract<Result, { status: 'measured' }> }[] = [];
  for (const { review, runIndex, sourceDir, bundleDir } of prepared) {
    const submission = readSubmission(sourceDir), bundle = readSubmission(bundleDir), info = readRun(sourceDir);
    if (info.cutoffDate !== review.cutoffDate) throw new Error('元の実行の検索日が対象と一致しません');
    const validated = validateFormulaMd(readFileSync(join(sourceDir, 'submissions', `${submission.number}.md`), 'utf8'));
    if (!validated.ok || validated.query !== submission.query) throw new Error('元の提出の式が不正か記録と一致しません');
    const { units, undetermined } = requiredUnits(validated.formula);
    if (undetermined) { skippedRuns.undetermined++; continue; }
    const score = readJson(join(sourceDir, 'score.json')) as { outcome: { capturedPmids: string[] } };
    if (!Array.isArray(score.outcome.capturedPmids) || score.outcome.capturedPmids.some((pmid) => typeof pmid !== 'string')) throw new Error('採点記録が不正です');
    const missedGold = review.evaluablePmids.filter((pmid) => !score.outcome.capturedPmids.includes(pmid)).length;
    const deps = createDeps({ env, fetchImpl, sleep, cutoffDate: info.cutoffDate, rateLimiter: base.rateLimiter, timeoutMs: runtime.timeoutMs });
    for (const unit of units.filter((unit) => !unit.negative && classifyLine(unit, false) === 'concept')) {
      const queries = outsideQueries(units, unit.id, bundle.query);
      if (!queries) { skippedTargets++; continue; }
      const path = join(options.root, '_cache', 'sample-yield', `${options.source}-${options.bundle}`, review.pmcid, `run-${runIndex}`, `${unit.id}.json`);
      const fingerprint = createHash('sha256').update(['sample-yield-v2', submission.query, bundle.query, unit.expression,
        info.cutoffDate, [...review.evaluablePmids].sort().join('\n'), [...score.outcome.capturedPmids].sort().join('\n')].join('\n')).digest('hex');
      const existed = existsSync(path), saved = existed ? readResult(path, fingerprint) : null;
      let result: CachedResult;
      if (saved) { result = saved; cached++; }
      else {
        let outcome: Result;
        try { outcome = await measure(queries, review.evaluablePmids, missedGold, deps); }
        catch (error) {
          if (isQueryRejection(error)) outcome = { status: 'rejected' };
          else throw new Error('見本の測定に失敗しました（結果不明）: ' + safeCause(error, env.NCBI_API_KEY ?? ''));
        }
        result = { ...outcome, fingerprint, measuredAt: now().toISOString() };
        mkdirSync(dirname(path), { recursive: true });
        writeJson(path, result);
        if (existed) remeasured++;
        else measured++;
      }
      measuredDates.push(result.measuredAt);
      if (result.status === 'rejected') rejectedTargets++;
      else { records.push({ review: review.pmcid, result }); runMissed.set(sourceDir, result.missedGold); }
    }
  }
  const missedGold = [...runMissed.values()].reduce((sum, value) => sum + value, 0);
  measuredDates.sort((a, b) => Date.parse(a) - Date.parse(b));
  const summaries = Object.fromEntries(methods.map((method) => {
    const rows = records.map((row) => row.result.methods[method]);
    const total = (key: keyof Counts) => rows.reduce((sum, row) => sum + row[key], 0);
    const sampleGoldTotal = total('sampleGold'), sampleSizeTotal = total('sampleSize'), poolGoldTotal = total('poolGold');
    const targetsWithGold = rows.filter((row) => row.sampleGold > 0).length;
    const hits = rows.map((row) => row.poolHits);
    return [method, { samples: rows.filter((row) => row.sampleSize > 0).length, sampleGoldTotal, sampleSizeTotal,
      precision: sampleSizeTotal ? sampleGoldTotal / sampleSizeTotal : null, targetsWithGold,
      targetsWithGoldRate: rows.length ? targetsWithGold / rows.length : null,
      reviewsWithGold: new Set(records.filter((row) => row.result.methods[method].sampleGold > 0).map((row) => row.review)).size,
      poolGoldTotal, poolGoldPerMissed: missedGold ? poolGoldTotal / missedGold : null,
      poolHitsQuantiles: { min: quantile(hits, 0), q1: quantile(hits, 0.25), median: quantile(hits, 0.5), q3: quantile(hits, 0.75), max: quantile(hits, 1) } }];
  }));
  const reportsDir = runtime.reportsDir ?? resolve(__dirname, '../reports');
  mkdirSync(reportsDir, { recursive: true });
  writeJson(join(reportsDir, `sample-yield-${options.source}-${options.bundle}-${options.subset}.json`), {
    source: options.source, bundle: options.bundle, subset: options.subset, reviews: reviews.length, runsPerReview: options.runsPerReview,
    generatedAt: now().toISOString(), targets: records.length, skippedRuns, skippedTargets, rejectedTargets, missedGold, methods: summaries,
    runs: runMissed.size, measuredFrom: measuredDates[0] ?? null, measuredTo: measuredDates[measuredDates.length - 1] ?? null,
  });
  stdout(`対象のレビュー × 回: ${all.length} 件\n`);
  stdout(`測った対象: 新規 ${measured} 件、保存済み ${cached} 件、測り直し ${remeasured} 件\n`);
  stdout(`対象外の実行: ${skippedRuns.undetermined} 件\n`);
  stdout(`対象外の対象: ${skippedTargets} 件\n`);
  stdout(`拒否された対象: ${rejectedTargets} 件\n`);
  return 0;
}

export async function main(args: string[], runtime: RunRuntime = defaultRuntime()): Promise<number> {
  try { return await sampleYield(args, runtime); }
  catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException)?.code) throw new Error('見本の下調べのファイルの読み書きに失敗しました');
    throw error;
  }
}
if (require.main === module) {
  installDomParser();
  config();
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(redact(String(error), [process.env.NCBI_API_KEY ?? '']) + '\n'); process.exitCode = 1;
  });
}
