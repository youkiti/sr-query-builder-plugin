import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from 'dotenv';
import { redact } from '../../query-optimization-bench/ncbiEval';
import { casesDir } from './cases';
import { loadConditions } from './conditions';
import { createRun, recordToolCall, runPath, writeJson } from './runDir';
import { readSubmissionState } from './scoreRuns';
import { parseRunOptions, targetReviews, type RunRuntime } from './startRuns';
import { validateFormulaMd } from './submission';
import { defaultRuntime } from './tool';

export function main(args: string[], runtime: RunRuntime = defaultRuntime()): number {
  const options = parseRunOptions(args, '--runs');
  const conditions = loadConditions(options.version, runtime.harnessDir);
  if (!conditions.combine) throw new Error('束ねる条件がありません');
  const { from, k } = conditions.combine;
  const reviews = targetReviews(options, runtime);
  const all = reviews.flatMap((review) => Array.from({ length: options.runsPerReview }, (_, i) => ({
    review, runIndex: i + 1, dir: runPath(options.root, options.version, review.pmcid, i + 1),
    sources: Array.from({ length: k }, (_, offset) => {
      const runIndex = i * k + offset + 1;
      return { runIndex, dir: runPath(options.root, from, review.pmcid, runIndex) };
    }),
  })));
  const missing = all.flatMap((run) => run.sources).filter(({ dir }) => !existsSync(dir) || !statSync(dir).isDirectory()).length;
  const existing = all.filter(({ dir }) => existsSync(dir)).length;
  if (missing) throw new Error(`元の実行フォルダが ${missing} 件不足しています`);
  if (existing) throw new Error(`束ねた版の実行フォルダが ${existing} 件既にあります`);
  let submitted = 0;
  let complete = 0;
  for (const { review, runIndex, sources } of all) {
    const available = sources.flatMap((source) => {
      const { submission } = readSubmissionState(source.dir);
      return submission ? [{ runIndex: source.runIndex, query: submission.query }] : [];
    });
    const queries = [...new Set(available.map((source) => source.query))];
    const md = '## PubMed/MEDLINE\n\n```\n#1 ' + queries.map((query) => `(${query})`).join(' OR ') + '\n```\n';
    const validated = queries.length ? validateFormulaMd(md) : null;
    if (validated && !validated.ok) throw new Error(`束ねた式の検査に失敗しました: ${validated.reasons.join('、')}`);
    const dir = createRun({ root: options.root, version: options.version, pmcid: review.pmcid, runIndex,
      cutoffDate: review.cutoffDate, protocolPath: join(runtime.casesDir ?? casesDir(), review.pmcid, 'protocol.md'),
      conditions, now: runtime.now });
    if (available.length === k) complete++;
    if (validated?.ok) {
      const submittedAt = runtime.now().toISOString();
      mkdirSync(join(dir, 'submissions'));
      writeFileSync(join(dir, 'submissions', '1.md'), md);
      writeJson(join(dir, 'submission.json'), { number: 1, submittedAt, query: validated.query,
        combinedFrom: available.map((source) => source.runIndex) });
      recordToolCall(dir, { measurements: 0, submissions: 1 }, { at: submittedAt, command: 'submit', args: '束ねた式 1 件',
        result: '成功', remaining: { measurements: conditions.maxMeasurements, submissions: conditions.maxSubmissions - 1 } });
      submitted++;
    }
  }
  runtime.stdout(`作成: ${all.length} 件\n`);
  runtime.stdout(`束ねた式: ${submitted} 件\n`);
  runtime.stdout(`提出なし: ${all.length - submitted} 件\n`);
  runtime.stdout(`元の式が ${k} 個: ${complete} 件、${k} 個未満: ${all.length - complete} 件\n`);
  return 0;
}
if (require.main === module) {
  config();
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(redact(String(error), [process.env.NCBI_API_KEY ?? '']) + '\n'); process.exitCode = 1; }
}
