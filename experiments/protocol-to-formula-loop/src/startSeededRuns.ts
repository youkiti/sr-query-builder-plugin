import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from 'dotenv';
import { efetchArticles, type EfetchArticle } from '../../../src/lib/ncbi/eutils';
import { installDomParser } from '../../query-optimization-bench/domParser';
import { redact } from '../../query-optimization-bench/ncbiEval';
import { casesDir } from './cases';
import { loadConditions } from './conditions';
import { createDeps } from './ncbi';
import { createRun, runPath, writeJson } from './runDir';
import { readSeedSelection } from './seedSelect';
import { parseRunOptions, targetReviews, type RunRuntime } from './startRuns';
import { defaultRuntime } from './tool';

function seedsMarkdown(articles: EfetchArticle[]): string {
  if (!articles.length) return '# シード論文\nこのレビューでは、シード論文は見つかっていません。\n';
  return '# シード論文（このレビューに組み入れられると、人が判定した論文）\n'
    + '以下の論文の書誌を参考に、シード以外の研究も拾える検索式を作成してください。\n\n'
    + articles.map((article, i) => `## シード ${i + 1}\nPMID: ${article.pmid}\n題: ${article.title ?? '（題なし）'}\n`
      + `MeSH 見出し: ${article.meshDetails.map((heading) => `${heading.majorTopic ? '*' : ''}${heading.descriptor}`).join(', ') || '（未付与）'}\n`
      + `抄録: ${article.abstract || '（抄録なし）'}\n`).join('\n');
}

async function startSeededRuns(args: string[], runtime: RunRuntime): Promise<number> {
  const options = parseRunOptions(args, '--out');
  const conditions = loadConditions(options.version, runtime.harnessDir);
  if (!conditions.seeds) throw new Error('この版はシードを使いません（startRuns を使ってください）');
  const seeds = conditions.seeds;
  let reviews: ReturnType<typeof targetReviews>;
  try { reviews = targetReviews(options, runtime); }
  catch { throw new Error('対象レビューの記録の読み込みに失敗しました'); }
  const all = reviews.map((review) => {
    const path = join(options.root, '_seeds', seeds.label, `${review.pmcid}.json`);
    return { review, selection: existsSync(path) ? readSeedSelection(path) : null };
  });
  const missing = all.filter(({ selection }) => !selection || selection.max !== seeds.max).length;
  if (missing) throw new Error(`シードの選定が ${missing} 件不足しています`);
  for (const { review } of all) for (let i = 1; i <= options.runsPerReview; i++) {
    if (existsSync(runPath(options.root, options.version, review.pmcid, i))) throw new Error('実行フォルダが既にあります');
  }
  const deps = createDeps({ env: runtime.env, fetchImpl: runtime.fetchImpl, sleep: runtime.sleep,
    rateLimiter: runtime.rateLimiter, timeoutMs: runtime.timeoutMs });
  let count = 0, seeded = 0;
  // 書誌はすべて取得し終えてから実行フォルダを作る（途中で通信が失敗しても、作りかけを残さず同じコマンドでやり直せる）。
  const prepared: { review: (typeof all)[number]['review']; pmids: string[]; md: string }[] = [];
  for (const { review, selection } of all) {
    const pmids = selection!.pmids;
    let articles: EfetchArticle[] = [];
    if (pmids.length) {
      try { articles = await efetchArticles(pmids, deps); }
      catch { throw new Error('シードの書誌の取得に失敗しました（結果不明）'); }
      const fetched = new Set(articles.map((article) => article.pmid));
      if (fetched.size !== pmids.length || articles.length !== pmids.length || pmids.some((pmid) => !fetched.has(pmid))) {
        throw new Error('シードの書誌の取得に失敗しました（結果不明）: 取得した集合が一致しません');
      }
      seeded++;
    }
    prepared.push({ review, pmids, md: seedsMarkdown(pmids.map((pmid) => articles.find((article) => article.pmid === pmid)!)) });
  }
  for (const { review, pmids, md } of prepared) {
    for (let runIndex = 1; runIndex <= options.runsPerReview; runIndex++) {
      const dir = createRun({ root: options.root, version: options.version, pmcid: review.pmcid, runIndex,
        cutoffDate: review.cutoffDate, protocolPath: join(runtime.casesDir ?? casesDir(), review.pmcid, 'protocol.md'), conditions, now: runtime.now });
      writeJson(join(dir, 'seeds.json'), { pmids });
      writeFileSync(join(dir, 'seeds.md'), md);
      count++;
    }
  }
  runtime.stdout(`作成: ${count} 件\n`);
  runtime.stdout(`シードあり: ${seeded} 件、シードなし: ${reviews.length - seeded} 件\n`);
  return 0;
}

export async function main(args: string[], runtime: RunRuntime = defaultRuntime()): Promise<number> {
  try { return await startSeededRuns(args, runtime); }
  catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException)?.code) throw new Error('シード付き実行のファイルの読み書きに失敗しました');
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
