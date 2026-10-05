import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from 'dotenv';
import { capturedGold, redact } from '../../query-optimization-bench/ncbiEval';
import { loadReviews, resolveBenchDir, TIERS } from './bench';
import { casesDir } from './cases';
import { applyEvaluable, loadEvaluable, type EvaluableRecord } from './evaluable';
import { createDeps } from './ncbi';
import { defaultRuntime, type Runtime } from './tool';

export async function main(args: string[], runtime: Runtime & { casesDir?: string } = defaultRuntime()): Promise<number> {
  if (args.some((arg) => arg !== '--force')) throw new Error('指定できる引数は --force だけです');
  const { env, fetchImpl, now, stdout, stderr, sleep } = runtime;
  const output = runtime.casesDir ?? casesDir();
  const reviews = loadReviews(resolveBenchDir(env));
  mkdirSync(output, { recursive: true });
  const path = join(output, 'evaluable.jsonl');
  const records = existsSync(path) ? loadEvaluable(output) : new Map<string, EvaluableRecord>();
  const base = createDeps({ env, fetchImpl, sleep });
  let fetched = 0;
  let skipped = 0;
  let failed = 0;
  for (const review of reviews) {
    if (records.has(review.pmcid) && !args.includes('--force')) { skipped++; continue; }
    try {
      const dated = { ...createDeps({ env, fetchImpl, sleep, cutoffDate: review.cutoffDate }), rateLimiter: base.rateLimiter };
      const existing = review.includedPmids.length ? await capturedGold('', review.includedPmids, base) : [];
      const withinCutoff = review.includedPmids.length ? await capturedGold('', review.includedPmids, dated) : [];
      const record = { pmcid: review.pmcid, cutoffDate: review.cutoffDate, measuredAt: now().toISOString(), existing, withinCutoff };
      applyEvaluable(review, record);
      appendFileSync(path, JSON.stringify(record) + '\n');
      records.set(review.pmcid, record);
      fetched++;
    } catch (error) {
      failed++;
      stderr(`${review.pmcid}: ${redact(String(error), [env.NCBI_API_KEY ?? ''])}\n`);
    }
  }
  stdout(`対象: ${reviews.length} 件／今回取得: ${fetched} 件／既存で省略: ${skipped} 件／失敗: ${failed} 件\n`);
  stdout('ティア\tレビュー数\t外した報告数\t外した研究数\t外したレビュー数\t残るレビュー数\t存在しない\t検索日より後\n');
  for (const tier of TIERS) {
    const rows = reviews.filter((review) => review.tier === tier);
    const measured = rows.flatMap((review) => {
      const record = records.get(review.pmcid);
      return record ? [applyEvaluable(review, record)] : [];
    });
    const sum = (key: 'excludedReports' | 'excludedStudies' | 'nonexistentReports' | 'afterCutoffReports') => measured.reduce((n, row) => n + row[key], 0);
    stdout([tier, rows.length, sum('excludedReports'), sum('excludedStudies'), measured.filter((r) => !r.evaluable).length,
      measured.filter((r) => r.evaluable).length, sum('nonexistentReports'), sum('afterCutoffReports')].join('\t') + '\n');
  }
  const complete = records.size === reviews.length && reviews.every((review) => records.has(review.pmcid));
  return failed || !complete ? 1 : 0;
}

if (require.main === module) {
  config();
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(redact(String(error), [process.env.NCBI_API_KEY ?? '']) + '\n'); process.exitCode = 1;
  });
}
