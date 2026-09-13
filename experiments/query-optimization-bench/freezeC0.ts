import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from 'dotenv';
import { installDomParser } from './domParser';
import { buildSeedContext, generateDraftFormula } from '../../src/app/services/draftService';
import { extractProtocol } from '../../src/features/formula/skills/extractProtocol';
import { expandFormula } from '../../src/features/validation/expandFormula';
import { DEFAULT_OPTIMIZATION_MAX_HITS } from '../../src/app/services/queryOptimizationSettingsService';
import { GeminiProvider } from '../../src/lib/llm/GeminiProvider';
import { efetchArticles } from '../../src/lib/ncbi';
import { esearch, type EutilsDeps } from '../../src/lib/ncbi/eutils';
import type { LlmProviderFactory } from '../../src/app/services/llmProviderService';
import { FIXTURES, SEED, loadSeedsFile, seedSplitId, validateSeeds } from './prepare';
import { createEvalFetch, redact } from './ncbiEval';
import { loggedFactory, RESULTS } from './run';
import { CASES, type BenchCase, type FrozenSeeds } from './types';
import { c0Dir, c0FileName, c0FixturePath, hashC0Content, type C0Content, type C0Variant } from './c0Artifact';
import { getGitCommit, isGitDirty } from './gitInfo';

export interface FreezeArgs {
  caseId: string;
  variant: C0Variant;
  draftIndex: number;
  /** シード分割の乱数。既定は SEED（seeded 版でのみ意味を持つ）。 */
  seed: number;
  dryRun: boolean;
}

export function parseFreezeArgs(args: string[]): FreezeArgs {
  let caseId: string | undefined;
  let variant: string | undefined;
  let draftArg: string | undefined;
  let seedArg: string | undefined;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') dryRun = true;
    else if (args[i] === '--case' && caseId === undefined && args[i + 1]) caseId = args[++i];
    else if (args[i] === '--variant' && variant === undefined && args[i + 1]) variant = args[++i];
    else if (args[i] === '--draft' && draftArg === undefined && args[i + 1]) draftArg = args[++i];
    else if (args[i] === '--seeds' && seedArg === undefined && args[i + 1]) seedArg = args[++i];
    else throw new Error(`未対応の引数: ${args[i]}`);
  }
  if (!caseId || !CASES.some((item) => item.id === caseId)) throw new Error('--case には既知のケース ID を指定してください');
  if (variant !== 'criteria-only' && variant !== 'seeded') throw new Error('--variant には criteria-only または seeded を指定してください');
  // 直前のガードで実行時には criteria-only | seeded に限定済みだが、string は有限リテラルへ絞り込めないため明示キャストする。
  const resolvedVariant = variant as C0Variant;
  const draftIndex = draftArg === undefined ? 1 : Number(draftArg);
  if (!Number.isSafeInteger(draftIndex) || draftIndex <= 0) throw new Error('--draft には正の整数を指定してください');
  let seed = SEED;
  if (seedArg !== undefined) {
    seed = Number(seedArg);
    if (!Number.isSafeInteger(seed)) throw new Error('--seeds には整数を指定してください');
  }
  return { caseId, variant: resolvedVariant, draftIndex, seed, dryRun };
}

export interface GenerateC0Input {
  caseId: string;
  variant: C0Variant;
  draftIndex: number;
  seedSplit: string | null;
  protocolText: string;
  seeds: FrozenSeeds;
}

export interface GenerateC0Deps {
  llmFactory: LlmProviderFactory;
  eutils: EutilsDeps;
}

/**
 * LLM/NCBI 呼び出しを伴う本体。main() から CLI 解析・fs・GeminiProvider 配線を切り離してあり、
 * テストでは llmFactory/eutils をフェイクに差し替えて実ネットワーク無しで検証する。
 */
export async function generateC0Content(input: GenerateC0Input, deps: GenerateC0Deps): Promise<C0Content> {
  const extracted = await extractProtocol(input.protocolText, deps.llmFactory.forPurpose('extract_protocol'));
  const protocol = { ...extracted, sourceType: 'markdown' as const, sourceFilename: 'protocol.md', rawTextRef: null,
    rawTextPreview: input.protocolText.slice(0, 500), rawTextInline: input.protocolText };
  const blocks = { blocks: extracted.blocks.map((block) => ({ ...block, aiGenerated: true, note: '' })),
    combinationExpression: extracted.combinationExpression };
  let seedContext: Awaited<ReturnType<typeof buildSeedContext>> = { titles: [], samples: [], meshSummary: { seedCount: 0, concepts: [], checkTags: [] } };
  if (input.variant === 'seeded') {
    const seedPmids = input.seeds.selections.map((selection) => selection.pmid);
    const articles = await efetchArticles(seedPmids, deps.eutils);
    const fetchedPmids = new Set(articles.map((article) => article.pmid));
    const missing = seedPmids.filter((pmid) => !fetchedPmids.has(pmid));
    // 一部でも取得できなければ、seeded を名乗りながら実質シード無しの C0 を凍結してしまう
    // （静かな劣化）ため、空の seedContext へフォールバックせず失敗させる。
    if (missing.length > 0 || articles.length !== seedPmids.length) {
      throw new Error(`凍結シードの一部を efetch で取得できませんでした（missing: ${missing.join(', ') || '重複/不足'}）。`
        + 'seeded の凍結を中止します（空の seedContext では凍結しない）');
    }
    seedContext = buildSeedContext(articles);
  }
  // C0 はどのプロファイルにも依存させない（--profile / --max-hits をまたいで使い回すため）目安を固定する。
  const draft = await generateDraftFormula({ protocol, blocks, targetHits: DEFAULT_OPTIMIZATION_MAX_HITS, seedContext },
    { llmFactory: deps.llmFactory, countBlockHits: async (query) => (await esearch(query, deps.eutils, { retmax: 0 })).count });
  const checks = draft.formula.blocks.filter((block) => !block.isCombination)
    .map((block) => ({ label: `#${block.id}`, query: block.expression }));
  checks.push({ label: '式全体', query: expandFormula(draft.formula) });
  const errors: string[] = [];
  for (const { label, query } of checks) {
    try {
      await esearch(query, deps.eutils, { retmax: 0 });
    } catch (err) {
      errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (errors.length > 0) {
    throw new Error(`${errors.join('\n')}\n実測できない C0 は凍結しない。再生成するには --draft で別番号を指定する`);
  }
  return {
    schemaVersion: 1, caseId: input.caseId, variant: input.variant, draftIndex: input.draftIndex, seedSplit: input.seedSplit,
    targetHits: DEFAULT_OPTIMIZATION_MAX_HITS, model: deps.llmFactory.model, createdAt: new Date().toISOString(),
    gitCommit: getGitCommit(), gitDirty: isGitDirty(), protocol, blocks, formula: draft.formula, formulaMd: draft.markdown,
    seedContext: input.variant === 'seeded' ? seedContext : null, blockApproval: 'auto',
  };
}

export async function main(args = process.argv.slice(2), fixturesDir = FIXTURES, resultsDir = RESULTS): Promise<void> {
  const { caseId, variant, draftIndex, seed, dryRun } = parseFreezeArgs(args);
  const fixtureDir = join(fixturesDir, caseId);
  const fixture = JSON.parse(readFileSync(join(fixtureDir, 'case.json'), 'utf8')) as BenchCase;
  const seeds = loadSeedsFile(fixtureDir, seed);
  validateSeeds(seeds, fixture.gold);
  const splitId = seedSplitId(seed);
  // ファイル名の接尾辞は既定分割（SEED）では付けない（README の命名規則。--c0 で拡張子抜きの名前を
  // そのまま指定するため、既定分割の名前には分割 id を含めない）。
  // ただし artifact 内の seedSplit は常に実際の分割 id を記録する（run.ts の --c0 検証で比較するため）。
  const outName = c0FileName(variant, draftIndex, variant === 'seeded' && seed !== SEED ? splitId : null);
  const outDir = c0Dir(fixturesDir, caseId);
  const outPath = c0FixturePath(fixturesDir, caseId, outName);
  if (dryRun) {
    process.stdout.write(`${caseId}: dry-run OK (variant=${variant}, draft=${draftIndex}, `
      + `seedSplit=${variant === 'seeded' ? splitId : 'なし'}) -> ${outPath}\n`);
    return;
  }
  if (existsSync(outPath)) {
    throw new Error(`${outPath} は既に存在します。再生成する場合は手動で削除してから実行してください`);
  }
  config();
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY が未設定です');
  // efetchArticles（seeded 版）は DOMParser に依存する。Node 実行なので jsdom から補う。
  installDomParser();
  const secrets = [process.env.GEMINI_API_KEY ?? '', process.env.NCBI_API_KEY ?? ''];
  const observed = createEvalFetch(fixture.searchDate, globalThis.fetch, () => undefined, secrets);
  const provider = new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY ?? '', fetch: observed });
  // 評価計画 §6 のとおり、C0 生成の LLM 呼び出しもプロンプト/レスポンス全文を保存する
  // （run.ts の生実行と同じ loggedFactory を再利用）。results/ は gitignore 対象。
  const llmLogDir = join(resultsDir, 'freeze-c0', caseId, outName);
  mkdirSync(join(llmLogDir, 'llm'), { recursive: true });
  const llmLogPaths: string[] = [];
  const llmFactory = loggedFactory(provider, (path, value) => {
    writeFileSync(join(llmLogDir, path), redact(JSON.stringify(value, null, 2), secrets) + '\n');
  }, llmLogPaths);
  const eutils: EutilsDeps = { fetch: observed, apiKey: process.env.NCBI_API_KEY, strictCounts: true };
  const protocolText = readFileSync(join(fixtureDir, fixture.protocolPath), 'utf8');
  const content = await generateC0Content({ caseId, variant, draftIndex, seedSplit: variant === 'seeded' ? splitId : null, protocolText, seeds },
    { llmFactory, eutils });
  const sha256 = hashC0Content(content);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outPath, JSON.stringify({ ...content, sha256 }, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(`${caseId}: ${outName} を書き出しました (sha256=${sha256.slice(0, 12)}…)\n`
    + `${caseId}: LLM ログ: ${join(llmLogDir, 'llm')}\n`);
}

if (require.main === module) void main().catch((err: unknown) => {
  process.stderr.write(`${redact(err instanceof Error ? err.message : String(err), [process.env.GEMINI_API_KEY ?? '', process.env.NCBI_API_KEY ?? ''])}\n`);
  process.exitCode = 1;
});
