/**
 * optimize_query（自動調整の AI 入力）へ渡すプロンプトの長さを、既存の評価結果 run.json から
 * 再現して測る CLI。issue #176 後半（試行履歴の要約化）の変更前後でプロンプト長を比較するために使う。
 *
 * 実通信はしない: LLMProvider をフェイクにし、受け取った system / user メッセージの文字数だけを記録して
 * 最小の finish 応答を返す。run.json の trials を 1 件目から k 件目まで増やしながら、各 k で
 * optimizeQuery() に渡した user プロンプトの文字数を出す。
 *
 * このスクリプトは変更前の worktree（trial_detail_ids・MAX_TRIAL_DETAILS_PER_REQUEST が無い版）に
 * そのままコピーしても動くこと。そのため trial_detail_ids / trialDetails など、試行履歴の要約化で追加した
 * フィールドには一切触れない（optimizeQuery の入力・出力とも、変更前から存在する形だけを使う）。
 */
import { readFileSync } from 'node:fs';
import { optimizeQuery, type OptimizeQueryInput, type OptimizationTrial,
  type OptimizationCriteria, type ApprovedOptimizationBlock } from '../../src/features/formula/skills/optimizeQuery';
import type { LLMProvider, ChatMessage } from '../../src/lib/llm/LLMProvider';
import type { PubmedFormula } from '../../src/lib/search-formula-md';

/** 使い捨てのダミー基準。取得できなかった run.json では常にこれを使い、注記に残す。 */
const FALLBACK_CRITERIA: OptimizationCriteria = {
  researchQuestion: '(run.json から取得できないためダミー)',
  inclusionCriteria: '(run.json から取得できないためダミー)',
  exclusionCriteria: '(run.json から取得できないためダミー)',
};
const FALLBACK_MAX_HITS = 2000;
const FALLBACK_SEED_PAPERS: { pmid: string; title: string | null }[] = [{ pmid: '1', title: null }];

export interface PromptSizeRow {
  k: number;
  userChars: number;
  systemChars: number;
}

export interface PromptSizeInputBase {
  approvedBlocks: ApprovedOptimizationBlock[];
  criteria: OptimizationCriteria;
  maxHits: number;
  seedPapers: { pmid: string; title: string | null }[];
  notes: string[];
}

/** チャット呼び出しを記録し、通信せずに最小の finish 応答を返す。 */
export function createFakeProvider(): { provider: LLMProvider; calls: readonly ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  const provider: LLMProvider = {
    providerId: 'gemini', model: 'prompt-size-fake',
    chat: async (messages) => {
      calls.push([...messages]);
      return {
        text: JSON.stringify({ action: 'finish', finish_kind: 'no_change_needed',
          rationale: 'プロンプトサイズ計測用のダミー応答', measurement_ids: [] }),
        tokensIn: null, tokensOut: null, raw: {},
      };
    },
  };
  return { provider, calls };
}

/** run.json の 1 レコードから、optimizeQuery に渡す固定入力を作る。取得できない項目はダミーで埋め、注記する。 */
export function buildInputBase(data: Record<string, unknown>, trials: OptimizationTrial[]): PromptSizeInputBase {
  const notes: string[] = [];
  const maxHits = typeof data.maxHits === 'number' && Number.isFinite(data.maxHits) ? data.maxHits
    : (notes.push(`maxHits を run.json から取得できず、既定値 ${FALLBACK_MAX_HITS} を使用`), FALLBACK_MAX_HITS);

  const initialFormula: PubmedFormula | undefined = trials[0]?.formula;
  const approvedBlocks: ApprovedOptimizationBlock[] = initialFormula
    ? initialFormula.blocks.filter((block) => !block.isCombination)
      .map((block) => ({ id: block.id, approvedBlockId: `approved-${block.id}`, label: `ブロック${block.id}` }))
    : [];
  if (!initialFormula) notes.push('承認済みブロックを run.json の初期式から取得できず、空配列を使用');

  // 実際の seedPapers（タイトル付き）は run.json に無いため、初期実測の捕捉・未捕捉 PMID の和を
  // 「run で使われたシード集合」の代用にする（変更前後で同じ入力になることだけが重要）。
  const initialMeasurement = trials[0]?.after;
  const seedPmids = initialMeasurement
    ? [...new Set([...(initialMeasurement.capturedPmids ?? []), ...(initialMeasurement.missedPmids ?? [])])]
    : null;
  const seedPapers = seedPmids?.length ? seedPmids.map((pmid) => ({ pmid, title: null })) : FALLBACK_SEED_PAPERS;
  if (!seedPmids?.length) notes.push('シード PMID を run.json の初期実測から取得できず、固定のダミー1件を使用');

  notes.push('研究基準（criteria）は run.json に含まれないため、常に固定のダミーを使用');
  return { approvedBlocks, criteria: FALLBACK_CRITERIA, maxHits, seedPapers, notes };
}

/** k 件目までの試行のうち、最後に採用された式と測定を「現在の最良式」とする。無ければ初期試行を使う。 */
function currentBest(trialsSoFar: readonly OptimizationTrial[]): { formula: PubmedFormula; measurement: OptimizationTrial['after'] } {
  for (let index = trialsSoFar.length - 1; index >= 0; index -= 1) {
    const trial = trialsSoFar[index]!;
    if (trial.accepted && trial.after) return { formula: trial.formula, measurement: trial.after };
  }
  const initial = trialsSoFar[0]!;
  return { formula: initial.formula, measurement: initial.after };
}

/** 試行履歴を 1 件目から k 件目まで増やしながら、各 k の user / system プロンプト長を測る。 */
export async function measurePromptSizes(trials: OptimizationTrial[], base: PromptSizeInputBase): Promise<PromptSizeRow[]> {
  const { provider, calls } = createFakeProvider();
  const rows: PromptSizeRow[] = [];
  for (let k = 1; k <= trials.length; k += 1) {
    const trialsSoFar = trials.slice(0, k);
    const { formula, measurement } = currentBest(trialsSoFar);
    const input: OptimizeQueryInput = {
      formula, approvedBlocks: base.approvedBlocks, criteria: base.criteria, maxHits: base.maxHits,
      measurement: measurement ?? undefined, seedPapers: base.seedPapers, trials: trialsSoFar,
    };
    await optimizeQuery(input, provider);
    const messages = calls[calls.length - 1]!;
    const system = messages.find((message) => message.role === 'system');
    const user = messages.find((message) => message.role === 'user');
    rows.push({ k, userChars: user?.content.length ?? 0, systemChars: system?.content.length ?? 0 });
  }
  return rows;
}

function readTrials(path: string): { trials: OptimizationTrial[]; data: Record<string, unknown> } {
  const data = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const optimization = data.optimization as Record<string, unknown> | undefined;
  const trials = optimization?.trials as OptimizationTrial[] | undefined;
  if (!trials?.length) throw new Error(`optimization.trials が見つかりません: ${path}`);
  return { trials, data };
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.length === 0) throw new Error('使い方: npm run eval:prompt-size -- <run.json> [<run.json> ...]');
  const summaries: { path: string; maxUserChars: number }[] = [];
  for (const path of args) {
    const { trials, data } = readTrials(path);
    const base = buildInputBase(data, trials);
    process.stdout.write(`# run: ${path}\n`);
    for (const note of base.notes) process.stdout.write(`# 注記: ${note}\n`);
    process.stdout.write('k,userChars,systemChars\n');
    const rows = await measurePromptSizes(trials, base);
    for (const row of rows) process.stdout.write(`${row.k},${row.userChars},${row.systemChars}\n`);
    summaries.push({ path, maxUserChars: rows.reduce((max, row) => Math.max(max, row.userChars), 0) });
  }
  process.stdout.write('\n');
  for (const summary of summaries) process.stdout.write(`${summary.path}: 最大 userChars = ${summary.maxUserChars}\n`);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write((err instanceof Error ? err.message : String(err)) + '\n');
    process.exitCode = 1;
  });
}
