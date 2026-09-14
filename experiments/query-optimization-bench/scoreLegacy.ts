import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { config } from 'dotenv';
import type { EutilsDeps } from '../../src/lib/ncbi/eutils';
import { computeAdoptionAudit } from './adoptionAudit';
import { getGitCommit, isGitDirty } from './gitInfo';
import { createEvalFetch, redact } from './ncbiEval';
import type { AdoptionAudit, RunResult } from './types';

const auditFailed = (audit?: AdoptionAudit): boolean =>
  !!audit && (audit.unscoredAdopted > 0 || audit.trials.some((trial) => trial.error !== undefined));

/** 試行ディレクトリの複製は、その runId と親ディレクトリ名で識別する。 */
export function collectLegacyRuns(paths: string[]): string[] {
  const found = new Set<string>();
  const visit = (path: string): void => {
    if (statSync(path).isDirectory()) {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        if (entry.isDirectory() || entry.isFile() && entry.name === 'run.json') visit(join(path, entry.name));
      }
    } else if (basename(path) === 'run.json') {
      const run = JSON.parse(readFileSync(path, 'utf8')) as RunResult;
      if (basename(dirname(path)) !== run.runId) found.add(path);
    }
  };
  paths.forEach((path) => visit(resolve(path)));
  return [...found].sort();
}

export async function main(args = process.argv.slice(2), eutils?: EutilsDeps): Promise<void> {
  const dryRun = args.includes('--dry-run');
  const paths = args.filter((arg) => arg !== '--dry-run');
  if (paths.some((path) => path.startsWith('--'))) throw new Error('未対応の引数です');
  if (!dryRun && !eutils) config();
  const secrets = [process.env.NCBI_API_KEY ?? '', process.env.GEMINI_API_KEY ?? ''];
  const log = (message: string) => process.stdout.write(redact(message, secrets) + '\n');
  const gitCommit = getGitCommit();
  const gitDirty = isGitDirty();
  let targets = 0;
  for (const path of collectLegacyRuns(paths)) {
    try {
      const result = JSON.parse(readFileSync(path, 'utf8')) as RunResult;
      if (result.legacy !== true || result.status !== 'completed') {
        log(`${path}: スキップ (${result.legacy !== true ? 'legacy ではありません' : `未完了: ${result.status}`})`);
        continue;
      }
      targets++;
      const destination = join(dirname(path), 'scored.json');
      if (dryRun) { log(`${path}: dry-run → ${destination}`); continue; }
      if (!gitCommit) throw new Error('採点コミットを取得できません');
      if (existsSync(destination)) {
        const scored = JSON.parse(readFileSync(destination, 'utf8')) as { gitCommit?: string; adoptionAudit?: AdoptionAudit };
        if (!auditFailed(scored.adoptionAudit)) {
          if (scored.gitCommit !== gitCommit) throw new Error('別コミットの scored.json があります');
          log(`${path}: 同じコミットで採点済みのためスキップ`);
          continue;
        }
      }
      const network = eutils ?? { fetch: globalThis.fetch, apiKey: process.env.NCBI_API_KEY, strictCounts: true };
      const adoptionAudit = await computeAdoptionAudit(result, { ...network,
        fetch: createEvalFetch(result.searchDate, network.fetch, () => undefined, secrets) });
      if (auditFailed(adoptionAudit)) throw new Error('監査の測定に失敗したため採点を保存しません');
      const scored = { adoptionAudit, scoredAt: new Date().toISOString(), gitCommit, gitDirty, source: result.runId };
      writeFileSync(`${destination}.tmp`, redact(JSON.stringify(scored, null, 2), secrets) + '\n');
      renameSync(`${destination}.tmp`, destination);
      log(`${path}: 採点を保存 (${destination})`);
    } catch (err) {
      log(`${path}: failed (${err instanceof Error ? err.message : String(err)})`);
      process.exitCode = 1;
    }
  }
  if (!targets) log('対象 0 件');
}

if (require.main === module) void main().catch((err: unknown) => {
  process.stderr.write(redact(err instanceof Error ? err.message : String(err),
    [process.env.NCBI_API_KEY ?? '', process.env.GEMINI_API_KEY ?? '']) + '\n');
  process.exitCode = 1;
});
