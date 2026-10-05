import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildProtocol } from '../../query-optimization-bench/prepare';
import { loadParsed, loadReviews, resolveBenchDir, TIERS } from './bench';
import { SPLITS, splitReviews } from './split';

export const casesDir = (): string => resolve(__dirname, '../cases');

export function main(benchDir = resolveBenchDir(), output = casesDir()): void {
  const reviews = loadReviews(benchDir);
  const splits = splitReviews(reviews);
  const index = reviews.map((review) => {
    const parsed = loadParsed(benchDir, review);
    const dir = join(output, review.pmcid);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'protocol.md'), buildProtocol(parsed));
    return { pmcid: review.pmcid, tier: review.tier, cutoffDate: review.cutoffDate, split: splits.get(review.pmcid)!,
      title: parsed.title, nStudies: review.studies.length, nPmids: review.includedPmids.length };
  });
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, 'index.jsonl'), index.map((row) => JSON.stringify(row)).join('\n') + (index.length ? '\n' : ''));
  process.stdout.write(`作成: ${index.length} 件\n`);
  for (const tier of TIERS) process.stdout.write(`${tier}: ${index.filter((row) => row.tier === tier).length} 件\n`);
  for (const split of SPLITS) process.stdout.write(`${split}: ${index.filter((row) => row.split === split).length} 件\n`);
}
if (require.main === module) {
  try { main(); } catch (error) { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; }
}
