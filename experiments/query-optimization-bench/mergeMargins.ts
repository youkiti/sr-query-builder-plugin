import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from 'dotenv';
import { buildBroadenedFormula, buildMarginQuery, type BlockRecallAdditions } from '../../src/features/formula/recallExpansion';
import { expandFormula } from '../../src/features/validation/expandFormula';
import { esearch, type EutilsDeps } from '../../src/lib/ncbi/eutils';
import { loadC0Artifact } from './c0Artifact';
import { hashMarginContent, loadMarginArtifact, marginFixturePath, validateMarginName, type MarginContent } from './freezeMargin';
import { getGitCommit, isGitDirty } from './gitInfo';
import { createEvalFetch, redact } from './ncbiEval';
import { FIXTURES } from './prepare';
import { reportError } from './run';
import { CASES, type BenchCase } from './types';

export interface MergeMarginsArgs {
  caseId: string;
  margins: string[];
  name: string;
  dryRun: boolean;
}

export function parseMergeMarginsArgs(args: string[]): MergeMarginsArgs {
  const values: Record<string, string> = {};
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (key === '--dry-run' && !dryRun) dryRun = true;
    else if (['--case', '--margins', '--name'].includes(key) && values[key] === undefined
      && args[i + 1] !== undefined && !args[i + 1]!.startsWith('--')) values[key] = args[++i]!;
    else throw new Error(`未対応・重複または値のない引数: ${key}`);
  }
  const caseId = values['--case'] ?? '';
  if (!CASES.some((item) => item.id === caseId)) throw new Error('--case には既知のケース ID を指定してください');
  const margins = (values['--margins'] ?? '').split(',');
  if (margins.length < 2) throw new Error('--margins には margin 名をカンマ区切りで 2 件以上指定してください');
  for (const margin of margins) validateMarginName(margin);
  if (new Set(margins).size !== margins.length) throw new Error('--margins に重複した margin 名があります');
  const name = values['--name'] ?? '';
  validateMarginName(name);
  return { caseId, margins, name, dryRun };
}

/** ブロックと語の初出順を保ち、前後の空白を除いた語で重複を除く。 */
export function mergeAdditions(margins: readonly Pick<MarginContent, 'additions'>[]): BlockRecallAdditions[] {
  const blocks = new Map<string, BlockRecallAdditions>();
  const seen = new Map<string, Set<string>>();
  for (const margin of margins) {
    for (const block of margin.additions) {
      if (!blocks.has(block.blockId)) {
        blocks.set(block.blockId, { blockId: block.blockId, additions: [] });
        seen.set(block.blockId, new Set());
      }
      for (const item of block.additions) {
        const term = item.term.trim();
        if (seen.get(block.blockId)!.has(term)) continue;
        seen.get(block.blockId)!.add(term);
        blocks.get(block.blockId)!.additions.push({ ...item, term });
      }
    }
  }
  return [...blocks.values()];
}

export async function main(args = process.argv.slice(2), fixturesDir = FIXTURES): Promise<void> {
  const { caseId, margins, name, dryRun } = parseMergeMarginsArgs(args);
  const outPath = marginFixturePath(fixturesDir, caseId, name);
  if (existsSync(outPath)) throw new Error(`${outPath} は既に存在します。別の --name を指定してください`);
  const artifacts = margins.map((margin) => loadMarginArtifact(fixturesDir, caseId, margin));
  const first = artifacts[0]!;
  for (const artifact of artifacts.slice(1)) {
    if (artifact.c0.name !== first.c0.name) throw new Error(`margin の参照先 C0 名が一致しません: ${first.name}, ${artifact.name}`);
    if (artifact.c0.sha256 !== first.c0.sha256) throw new Error(`margin の参照先 C0 ハッシュが一致しません: ${first.name}, ${artifact.name}`);
    if (artifact.searchDate !== first.searchDate) throw new Error(`margin の検索日が一致しません: ${first.name}, ${artifact.name}`);
  }
  const c0 = loadC0Artifact(fixturesDir, caseId, first.c0.name);
  if (c0.sha256 !== first.c0.sha256) throw new Error('margin が参照する C0 のハッシュが一致しません');
  const fixture = JSON.parse(readFileSync(join(fixturesDir, caseId, 'case.json'), 'utf8')) as BenchCase;
  if (first.searchDate !== fixture.searchDate) throw new Error('margin とケースの検索日が一致しません');
  const additions = mergeAdditions(artifacts);
  const originalQuery = expandFormula(c0.formula).trim();
  const broadenedQuery = expandFormula(buildBroadenedFormula(c0.formula, additions)).trim();
  const marginQuery = buildMarginQuery(broadenedQuery, originalQuery);
  if (dryRun) {
    const counts = additions.map((block) => `${block.blockId}: ${block.additions.length} 語`).join(', ');
    const total = additions.reduce((sum, block) => sum + block.additions.length, 0);
    process.stdout.write(`${caseId}: dry-run OK (margin・C0 ハッシュ検証済み、${counts}、合計 ${total} 語、通信・書き込みなし) -> ${outPath}\n`);
    return;
  }
  config();
  const secrets = [process.env.NCBI_API_KEY ?? '', process.env.GEMINI_API_KEY ?? ''];
  const observed = createEvalFetch(fixture.searchDate, globalThis.fetch, () => undefined, secrets);
  const eutils: EutilsDeps = { fetch: observed, apiKey: process.env.NCBI_API_KEY, strictCounts: true };
  const original = await esearch(originalQuery, eutils, { retmax: 0 });
  const margin = await esearch(marginQuery, eutils, { retmax: 0 });
  const generated: MarginContent = { schemaVersion: 1, name, caseId, c0: first.c0,
    sources: artifacts.map((artifact) => ({ name: artifact.name, sha256: artifact.sha256 })),
    additions, broadenedQuery, marginQuery, originalHits: original.count, marginHits: margin.count,
    searchDate: fixture.searchDate, model: 'merged', createdAt: new Date().toISOString(),
    gitCommit: getGitCommit(), gitDirty: isGitDirty() };
  // マスク後の保存内容でハッシュを計算する。
  const content = JSON.parse(redact(JSON.stringify(generated), secrets)) as MarginContent;
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({ ...content, sha256: hashMarginContent(content) }, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(`${caseId}: ${outPath} を書き出しました\n`);
}

if (require.main === module) void main().catch(reportError);
