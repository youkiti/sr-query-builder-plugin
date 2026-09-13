import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from 'dotenv';
import { prepareC0Context, finalizeC0Content, type GenerateC0Input, type GenerateC0Deps } from './c0Generation';
import { installDomParser } from './domParser';
import { generateDraftFormula } from '../../src/app/services/draftService';
import { DEFAULT_OPTIMIZATION_MAX_HITS } from '../../src/app/services/queryOptimizationSettingsService';
import { GeminiProvider } from '../../src/lib/llm/GeminiProvider';
import { esearch, type EutilsDeps } from '../../src/lib/ncbi/eutils';
import { FIXTURES, SEED, loadSeedsFile, parseSeedSplit, seedSplitId, validateSeeds, type SeedSplit } from './prepare';
import { createEvalFetch, redact } from './ncbiEval';
import { loggedFactory, RESULTS } from './run';
import { CASES, type BenchCase, type FrozenSeeds } from './types';
import { c0Dir, c0FileName, c0FixturePath, hashC0Content, type C0Content, type C0Variant } from './c0Artifact';

export interface FreezeArgs {
  caseId: string;
  variant: C0Variant;
  draftIndex: number;
  /** シード分割の乱数または集合名。既定は SEED（seeded 版でのみ意味を持つ）。 */
  seed: SeedSplit;
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
  if (variant === 'criteria-only' && seedArg !== undefined) throw new Error('criteria-only では --seeds は指定できません（シードを使用しないため）');
  // 直前のガードで実行時には criteria-only | seeded に限定済みだが、string は有限リテラルへ絞り込めないため明示キャストする。
  const resolvedVariant = variant as C0Variant;
  const draftIndex = draftArg === undefined ? 1 : Number(draftArg);
  if (!Number.isSafeInteger(draftIndex) || draftIndex <= 0) throw new Error('--draft には正の整数を指定してください');
  const seed = seedArg === undefined ? SEED : parseSeedSplit(seedArg);
  return { caseId, variant: resolvedVariant, draftIndex, seed, dryRun };
}

export type { GenerateC0Input, GenerateC0Deps } from './c0Generation';

/** 通信依存はテストでフェイクに差し替え、生成後の実測と内容の組み立てを取り込み経路と共有する。 */
export async function generateC0Content(input: GenerateC0Input, deps: GenerateC0Deps): Promise<C0Content> {
  const context = await prepareC0Context(input, deps);
  // C0 の目安はプロファイルに依存させず固定する。
  const draft = await generateDraftFormula({ ...context, targetHits: DEFAULT_OPTIMIZATION_MAX_HITS },
    { llmFactory: deps.llmFactory, countBlockHits: async (query) => (await esearch(query, deps.eutils, { retmax: 0 })).count });
  return finalizeC0Content(input, deps, context, draft);
}

/** criteria-only はシードの読み込み自体を省く。読み込み関数は通信・fs 無しのテスト用に差し替え可能。 */
export function loadFreezeSeeds(variant: C0Variant, fixtureDir: string, seed: SeedSplit, gold: BenchCase['gold'],
  load = loadSeedsFile): FrozenSeeds | undefined {
  if (variant === 'criteria-only') return undefined;
  const seeds = load(fixtureDir, seed);
  validateSeeds(seeds, gold);
  return seeds;
}

export async function main(args = process.argv.slice(2), fixturesDir = FIXTURES, resultsDir = RESULTS): Promise<void> {
  return freezeC0(parseFreezeArgs(args), fixturesDir, resultsDir);
}

/** 生成・取り込みで出力名、ログ保存、ハッシュと上書き禁止を統一する。 */
export async function freezeC0(options: FreezeArgs, fixturesDir: string, resultsDir: string,
  generateContent = generateC0Content): Promise<void> {
  const { caseId, variant, draftIndex, seed, dryRun } = options;
  const fixtureDir = join(fixturesDir, caseId);
  const fixture = JSON.parse(readFileSync(join(fixtureDir, 'case.json'), 'utf8')) as BenchCase;
  const seeds = loadFreezeSeeds(variant, fixtureDir, seed, fixture.gold);
  const splitId = seedSplitId(seed);
  // ファイル名の接尾辞は既定分割（SEED）では付けない（README の命名規則。--c0 で拡張子抜きの名前を
  // そのまま指定するため、既定分割の名前には分割 id を含めない）。
  // ただし artifact 内の seedSplit は常に実際の分割 id を記録する（run.ts の --c0 検証で比較するため）。
  const outName = c0FileName(variant, draftIndex, variant === 'seeded' && seed !== SEED ? splitId : null);
  const outDir = c0Dir(fixturesDir, caseId);
  const outPath = c0FixturePath(fixturesDir, caseId, outName);
  if (existsSync(outPath)) {
    throw new Error(`${outPath} は既に存在します。再生成する場合は手動で削除してから実行してください`);
  }
  if (dryRun) {
    process.stdout.write(`${caseId}: dry-run OK (variant=${variant}, draft=${draftIndex}, `
      + `seedSplit=${variant === 'seeded' ? splitId : 'なし'}) -> ${outPath}\n`);
    return;
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
  const content = await generateContent({ caseId, variant, draftIndex, seedSplit: variant === 'seeded' ? splitId : null, protocolText, seeds },
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
