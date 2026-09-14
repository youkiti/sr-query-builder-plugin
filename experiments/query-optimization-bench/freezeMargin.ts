import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from 'dotenv';
import { expandQueryForRecall } from '../../src/features/formula/skills/expandQueryForRecall';
import { buildBroadenedFormula, buildMarginQuery, type BlockRecallAdditions } from '../../src/features/formula/recallExpansion';
import { expandFormula } from '../../src/features/validation/expandFormula';
import { GeminiProvider } from '../../src/lib/llm/GeminiProvider';
import { esearch, type EutilsDeps } from '../../src/lib/ncbi/eutils';
import type { LlmProviderFactory } from '../../src/app/services/llmProviderService';
import { canonicalize, loadC0Artifact, type C0Artifact } from './c0Artifact';
import { getGitCommit, isGitDirty } from './gitInfo';
import { createEvalFetch, redact } from './ncbiEval';
import { FIXTURES } from './prepare';
import { loggedFactory, reportError, RESULTS } from './run';
import { CASES, type BenchCase } from './types';

export interface FreezeMarginArgs {
  caseId: string;
  c0Name: string;
  draftIndex: number;
  dryRun: boolean;
}

export interface MarginContent {
  schemaVersion: 1;
  name: string;
  caseId: string;
  c0: { name: string; sha256: string };
  sources?: { name: string; sha256: string }[];
  additions: BlockRecallAdditions[];
  broadenedQuery: string;
  marginQuery: string;
  originalHits: number;
  marginHits: number;
  searchDate: string;
  model: string;
  createdAt: string;
  gitCommit: string | null;
  gitDirty: boolean | null;
}

export interface MarginArtifact extends MarginContent { sha256: string }

export function validateMarginName(name: string): void {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) throw new Error('margin 名は英小文字で始まる英小文字・数字・ハイフンの 1〜64 文字で指定してください');
}

export function parseFreezeMarginArgs(args: string[]): FreezeMarginArgs {
  const values: Record<string, string> = {};
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (key === '--dry-run' && !dryRun) dryRun = true;
    else if (['--case', '--c0', '--draft'].includes(key) && values[key] === undefined
      && args[i + 1] !== undefined && !args[i + 1]!.startsWith('--')) values[key] = args[++i]!;
    else throw new Error(`未対応・重複または値のない引数: ${key}`);
  }
  const caseId = values['--case'] ?? '';
  if (!CASES.some((item) => item.id === caseId)) throw new Error('--case には既知のケース ID を指定してください');
  const c0Name = values['--c0'] ?? '';
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(c0Name)) throw new Error('--c0 には英小文字で始まる英小文字・数字・ハイフンの 1〜64 文字を指定してください');
  const draftIndex = values['--draft'] === undefined ? 1 : Number(values['--draft']);
  if (!Number.isSafeInteger(draftIndex) || draftIndex <= 0) throw new Error('--draft には正の整数を指定してください');
  validateMarginName(`${c0Name}-margin${draftIndex}`);
  return { caseId, c0Name, draftIndex, dryRun };
}

export function hashMarginContent(content: MarginContent): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(content))).digest('hex');
}

export function marginFixturePath(fixturesDir: string, caseId: string, name: string): string {
  validateMarginName(name);
  return join(fixturesDir, caseId, 'margin', `${name}.json`);
}

export function loadMarginArtifact(fixturesDir: string, caseId: string, name: string): MarginArtifact {
  const path = marginFixturePath(fixturesDir, caseId, name);
  if (!existsSync(path)) throw new Error(`margin fixture が見つかりません: ${path}`);
  const artifact = JSON.parse(readFileSync(path, 'utf8')) as MarginArtifact;
  const { sha256, ...content } = artifact;
  if (hashMarginContent(content) !== sha256) throw new Error(`margin のハッシュが一致しません: ${name}`);
  if (artifact.schemaVersion !== 1 || artifact.caseId !== caseId || artifact.name !== name) throw new Error(`margin の版・ケース ID・名前が一致しません: ${name}`);
  if (!artifact.c0 || !/^[a-z][a-z0-9-]{0,63}$/.test(artifact.c0.name)) throw new Error('margin の参照先 C0 名が不正です');
  if (!Array.isArray(artifact.additions) || artifact.additions.length === 0
    || typeof artifact.marginQuery !== 'string' || !artifact.marginQuery.trim()
    || typeof artifact.broadenedQuery !== 'string' || !artifact.broadenedQuery.trim()) throw new Error('margin の拡張語または検索式が空です');
  return artifact;
}

/** 凍結 C0 の非結合ブロックだけを渡し、製品と同じ関数で式を組み立てる。 */
export async function generateMarginContent(c0: C0Artifact, c0Name: string, name: string, searchDate: string,
  deps: { eutils: EutilsDeps; llmFactory: LlmProviderFactory }): Promise<MarginContent> {
  const additions = await expandQueryForRecall({ researchQuestion: c0.protocol.researchQuestion,
    blocks: c0.formula.blocks.filter((block) => !block.isCombination).map(({ id, expression }) => ({ id, expression })) },
  deps.llmFactory.forPurpose('expand_recall'));
  if (additions.length === 0) throw new Error('拡張語が 0 件のため margin を凍結しません');
  const originalQuery = expandFormula(c0.formula).trim();
  const broadenedQuery = expandFormula(buildBroadenedFormula(c0.formula, additions)).trim();
  const marginQuery = buildMarginQuery(broadenedQuery, originalQuery);
  const original = await esearch(originalQuery, deps.eutils, { retmax: 0 });
  const margin = await esearch(marginQuery, deps.eutils, { retmax: 0 });
  return { schemaVersion: 1, name, caseId: c0.caseId, c0: { name: c0Name, sha256: c0.sha256 }, additions,
    broadenedQuery, marginQuery, originalHits: original.count, marginHits: margin.count, searchDate,
    model: deps.llmFactory.model, createdAt: new Date().toISOString(), gitCommit: getGitCommit(), gitDirty: isGitDirty() };
}

export async function main(args = process.argv.slice(2), fixturesDir = FIXTURES, resultsDir = RESULTS): Promise<void> {
  const { caseId, c0Name, draftIndex, dryRun } = parseFreezeMarginArgs(args);
  const name = `${c0Name}-margin${draftIndex}`;
  const outPath = marginFixturePath(fixturesDir, caseId, name);
  if (existsSync(outPath)) throw new Error(`${outPath} は既に存在します。別の --draft を指定してください`);
  const c0 = loadC0Artifact(fixturesDir, caseId, c0Name);
  const fixture = JSON.parse(readFileSync(join(fixturesDir, caseId, 'case.json'), 'utf8')) as BenchCase;
  if (dryRun) {
    process.stdout.write(`${caseId}: dry-run OK (C0=${c0Name}, sha256=${c0.sha256}, ハッシュ検証済み、通信・書き込みなし) -> ${outPath}\n`);
    return;
  }
  config();
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY が未設定です');
  const secrets = [process.env.GEMINI_API_KEY, process.env.NCBI_API_KEY ?? ''];
  const observed = createEvalFetch(fixture.searchDate, globalThis.fetch, () => undefined, secrets);
  const provider = new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY, fetch: observed });
  const logDir = join(resultsDir, 'freeze-margin', caseId, name);
  mkdirSync(join(logDir, 'llm'), { recursive: true });
  const llmFactory = loggedFactory(provider, (path, value) => {
    writeFileSync(join(logDir, path), redact(JSON.stringify(value, null, 2), secrets) + '\n');
  }, []);
  const eutils: EutilsDeps = { fetch: observed, apiKey: process.env.NCBI_API_KEY, strictCounts: true };
  const generated = await generateMarginContent(c0, c0Name, name, fixture.searchDate, { eutils, llmFactory });
  // 保存する内容を先にマスクしてからハッシュ化し、読み込み時にも同じハッシュになるようにする。
  const content = JSON.parse(redact(JSON.stringify(generated), secrets)) as MarginContent;
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({ ...content, sha256: hashMarginContent(content) }, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(`${caseId}: ${outPath} を書き出しました。LLM ログ: ${join(logDir, 'llm')}\n`);
}

if (require.main === module) void main().catch(reportError);
