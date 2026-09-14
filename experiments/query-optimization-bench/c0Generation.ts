import { buildSeedContext } from '../../src/app/services/draftService';
import { extractProtocol } from '../../src/features/formula/skills/extractProtocol';
import { expandFormula } from '../../src/features/validation/expandFormula';
import { DEFAULT_OPTIMIZATION_MAX_HITS } from '../../src/app/services/queryOptimizationSettingsService';
import { efetchArticles } from '../../src/lib/ncbi';
import { esearch, EutilsError, type EutilsDeps } from '../../src/lib/ncbi/eutils';
import type { LlmProviderFactory } from '../../src/app/services/llmProviderService';
import type { PubmedFormula } from '../../src/lib/search-formula-md';
import type { FrozenSeeds } from './types';
import type { C0Content, C0Variant } from './c0Artifact';
import { getGitCommit, isGitDirty } from './gitInfo';

export interface GenerateC0Input {
  caseId: string;
  variant: C0Variant;
  draftIndex: number;
  seedSplit: string | null;
  protocolText: string;
  seeds?: FrozenSeeds;
}

export interface GenerateC0Deps {
  llmFactory: LlmProviderFactory;
  eutils: EutilsDeps;
}

/** 生成・取り込みに共通のプロトコル抽出とシード文脈の取得。 */
export async function prepareC0Context(input: GenerateC0Input, deps: GenerateC0Deps) {
  const extracted = await extractProtocol(input.protocolText, deps.llmFactory.forPurpose('extract_protocol'));
  const protocol = { ...extracted, sourceType: 'markdown' as const, sourceFilename: 'protocol.md', rawTextRef: null,
    rawTextPreview: input.protocolText.slice(0, 500), rawTextInline: input.protocolText };
  const blocks = { blocks: extracted.blocks.map((block) => ({ ...block, aiGenerated: true, note: '' })),
    combinationExpression: extracted.combinationExpression };
  let seedContext: Awaited<ReturnType<typeof buildSeedContext>> = { titles: [], samples: [], meshSummary: { seedCount: 0, concepts: [], checkTags: [] } };
  if (input.variant === 'seeded') {
    if (!input.seeds) throw new Error('seeded の凍結にはシードが必要です');
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
  return { protocol, blocks, seedContext };
}

/** 全非結合ブロックと式全体を実測し、失敗をまとめて返す。0 件は有効な結果。 */
export async function validateC0Formula(formula: PubmedFormula, eutils: EutilsDeps): Promise<void> {
  const checks = formula.blocks.filter((block) => !block.isCombination)
    .map((block) => ({ label: `#${block.id}`, query: block.expression }));
  checks.push({ label: '式全体', query: expandFormula(formula) });
  const errors: string[] = [];
  let permanentOnly = true;
  for (const { label, query } of checks) {
    try {
      await esearch(query, eutils, { retmax: 0 });
    } catch (err) {
      permanentOnly &&= err instanceof EutilsError && err.permanent;
      errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (errors.length > 0) {
    const rejection = permanentOnly
      ? '実測できない C0 は凍結しない。再生成するには --draft で別番号を指定する'
      : '実測中に一時的な通信障害があったため凍結しない。同じ番号で再試行できる';
    throw new Error(`${errors.join('\n')}\n${rejection}`);
  }
}

/** 実測できた式だけを共通のメタデータ形式に組み立てる。 */
export async function finalizeC0Content(input: GenerateC0Input, deps: GenerateC0Deps,
  context: Awaited<ReturnType<typeof prepareC0Context>>, draft: { formula: PubmedFormula; markdown: string }): Promise<C0Content> {
  await validateC0Formula(draft.formula, deps.eutils);
  const { protocol, blocks, seedContext } = context;
  return {
    schemaVersion: 1, caseId: input.caseId, variant: input.variant, draftIndex: input.draftIndex, seedSplit: input.seedSplit,
    targetHits: DEFAULT_OPTIMIZATION_MAX_HITS, model: deps.llmFactory.model, createdAt: new Date().toISOString(),
    gitCommit: getGitCommit(), gitDirty: isGitDirty(), protocol, blocks, formula: draft.formula, formulaMd: draft.markdown,
    seedContext: input.variant === 'seeded' ? seedContext : null, blockApproval: 'auto',
  };
}
