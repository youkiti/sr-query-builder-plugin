import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from 'dotenv';
import type { EutilsDeps } from '../../src/lib/ncbi/eutils';
import { measureRejectedCandidates, parseArgs, resultDir, RESULTS } from './run';
import { seedSplitId } from './prepare';
import { redact } from './ncbiEval';
import type { RunResult } from './types';

export async function main(args = process.argv.slice(2), resultsDir = RESULTS, eutils?: EutilsDeps): Promise<void> {
  const { ids, dryRun, profile, seed, c0Name, label, replayName } = parseArgs(args);
  if (!dryRun && !eutils) config();
  const c0Key = c0Name ?? 'live';
  const splitKey = seedSplitId(seed);
  for (const id of ids) {
    const path = join(resultDir(resultsDir, profile.id, id, c0Key, splitKey, label, replayName), 'run.json');
    let original: string;
    try { original = readFileSync(path, 'utf8'); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      process.stdout.write(`${id}: run.json が存在しないためスキップ (profile=${profile.id})\n`);
      continue;
    }
    const result = JSON.parse(original) as RunResult;
    if (result.id !== id) throw new Error(`${id}: run.json のケース ID が一致しません`);
    if (dryRun) {
      const count = result.optimization?.trials.filter((trial) => trial.kind === 'proposal' && !trial.accepted).length ?? 0;
      process.stdout.write(`${id}: dry-run; label=${label ?? '-'}, 却下候補=${count}, API calls=0\n`);
      continue;
    }
    const candidates = await measureRejectedCandidates(result, eutils ?? { fetch: globalThis.fetch, apiKey: process.env.NCBI_API_KEY, strictCounts: true });
    if (!candidates.length) {
      if (result.optimization?.trials.some((trial) => trial.kind === 'proposal' && !trial.accepted)) process.stdout.write(`${id}: 候補は計測済み; 追加計測なし\n`);
      continue;
    }
    result.rejectedCandidates = [...(result.rejectedCandidates ?? []).filter((old) => !candidates.some((candidate) => candidate.candidateId === old.candidateId)), ...candidates];
    if (readFileSync(path, 'utf8') !== original) throw new Error(`${id}: 計測中に run.json が変更されました`);
    writeFileSync(`${path}.tmp`, JSON.stringify(result, null, 2) + '\n');
    renameSync(`${path}.tmp`, path);
    process.stdout.write(`${id}: 候補事後計測=${candidates.length}\n`);
    if (candidates.some((candidate) => candidate.error)) throw new Error(`${id}: 候補の計測に失敗しました（run.json に記録）`);
  }
}

if (require.main === module) void main().catch((err: unknown) => {
  process.stderr.write(redact(err instanceof Error ? err.message : String(err), [process.env.NCBI_API_KEY ?? '']) + '\n');
  process.exitCode = 1;
});
