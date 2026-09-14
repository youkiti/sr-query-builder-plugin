import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MarginDesignVariantRun } from './marginDesign';
import { renderCsv, renderMarkdown } from './report';
import { RESULTS } from './run';

/**
 * `eval:margin-design`（issue #154）の run.json を集め、ケース × margin × 案ごとの比較表を
 * `results/margin-design/summary.md` / `summary.csv` に書き出す。
 * `eval:report`（run.ts の RunResult 用）とは対象スキーマが別のため、別コマンドにした。
 */

function findRunFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const runPath = join(dir, 'run.json');
  const files: string[] = existsSync(runPath) ? [runPath] : [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) files.push(...findRunFiles(join(dir, entry.name)));
  }
  return files;
}

function formatMarginHits(run: MarginDesignVariantRun): string {
  if (run.marginHitsByBlock) return run.marginHitsByBlock.map((block) => String(block.count)).join('+');
  return run.marginHits === null ? '-' : String(run.marginHits);
}

/** 研究名:判定@取得<順位|->/深い<順位|-> の形式。取得順位（一覧内の順位）と深い取得の順位（rankDepth
 * 件まで別途取得した順位）を混同しないよう明示する。per-block はどのブロックの順位かを (#ブロックID) で示す。 */
function formatMissedStudies(run: MarginDesignVariantRun): string {
  return run.heldOutStages.filter((study) => study.stage !== 'captured_by_current')
    .map((study) => {
      const blockSuffix = study.deepRankBlockId !== null ? ` (#${study.deepRankBlockId})` : '';
      return `${study.studyId}:${study.stage}@取得${study.retrievedRank ?? '-'}/深い${study.deepRank ?? '-'}${blockSuffix}`;
    }).join('; ');
}

function formatCost(usage: MarginDesignVariantRun['llmUsage']): string {
  if (!usage) return '欠測';
  if (usage.costUsd != null) return String(usage.costUsd);
  const reasons = [usage.unpricedCalls > 0 ? `価格表外 ${usage.unpricedCalls} 件` : '', usage.untrackedCalls > 0 ? `トークン不明 ${usage.untrackedCalls} 件` : ''].filter(Boolean);
  return reasons.length ? `欠測（${reasons.join('・')}）` : '欠測';
}

/** full → cutoff-<N>（N の数値昇順）→ per-block。文字列比較だと cutoff-500 と cutoff-1000 が逆転する。 */
function variantOrder(variant: string): readonly [number, number] {
  if (variant === 'full') return [0, 0];
  if (variant === 'per-block') return [2, 0];
  const match = /^cutoff-(\d+)$/.exec(variant);
  return match ? [1, Number(match[1])] : [3, 0];
}

function compareRuns(a: MarginDesignVariantRun, b: MarginDesignVariantRun): number {
  const [aKind, aNum] = variantOrder(a.variant);
  const [bKind, bNum] = variantOrder(b.variant);
  return a.caseId.localeCompare(b.caseId) || a.margin.name.localeCompare(b.margin.name) || a.seedSplit.localeCompare(b.seedSplit)
    || aKind - bKind || aNum - bNum || (a.label ?? '').localeCompare(b.label ?? '');
}

export function marginDesignRows(runs: readonly MarginDesignVariantRun[]): string[][] {
  const header = ['case', 'margin', 'seedSplit', 'variant', 'label', 'sameAs', 'keptTerms', 'marginHits', 'missedHeldOutCount', 'presentedCount',
    'missedStudies', 'fetchedCount', 'pickedCount', 'llmTokensIn', 'llmCostUsd', 'elapsedMs'];
  const rows: string[][] = [header];
  for (const run of [...runs].sort(compareRuns)) {
    if (run.status === 'failed') {
      rows.push([run.caseId, run.margin.name, run.seedSplit, run.variant, run.label ?? '-', run.sameAs ?? '-', String(run.keptTerms.length),
        '失敗', '失敗', '失敗', `失敗: ${run.error ?? '不明'}`, '失敗', '失敗', '失敗', '失敗', String(run.elapsedMs)]);
      continue;
    }
    // sameAs の run は選定・事後集計を再実行していないため、これらの列は「未測定」であって
    // 0 件・欠測ではない。参照先の案名を =<案名> の形で出し、比較表を「提示 0 件」と誤読させない。
    const sameAsRef = run.sameAs ? `=${run.sameAs}` : null;
    rows.push([run.caseId, run.margin.name, run.seedSplit, run.variant, run.label ?? '-', run.sameAs ?? '-', String(run.keptTerms.length),
      sameAsRef ?? formatMarginHits(run),
      sameAsRef ?? (run.missedHeldOutCount === null ? '-' : String(run.missedHeldOutCount)),
      sameAsRef ?? String(run.stageCounts.presented),
      formatMissedStudies(run),
      sameAsRef ?? String(run.stages?.fetchedPmids.length ?? 0),
      sameAsRef ?? String(run.candidates.length),
      sameAsRef ?? String(run.llmUsage.tokensIn),
      sameAsRef ?? formatCost(run.llmUsage),
      String(run.elapsedMs)]);
  }
  return rows;
}

export function report(resultsDir = RESULTS): void {
  const root = join(resultsDir, 'margin-design');
  mkdirSync(root, { recursive: true });
  const runs = findRunFiles(root).map((path) => JSON.parse(readFileSync(path, 'utf8')) as MarginDesignVariantRun);
  const rows = marginDesignRows(runs);
  writeFileSync(join(root, 'summary.csv'), renderCsv(rows));
  const context = 'seedSplit は --seeds で選んだシード分割（既定は s20260912）を区別する列。同じ case・margin でも分割が違えば held-out 集合が変わるため別の行として扱う。'
    + 'label は --label 付きの run を区別する列（無指定は -）。並び順は case/margin/seedSplit/variant（full → cutoff-<N> は N の数値昇順 → per-block）/label の順（文字列比較では cutoff-500 と cutoff-1000 が逆転するため数値で並べる）。'
    + 'sameAs は既に計算した案（full または先に処理した cutoff）と拡張語集合が同一だったため、選定・事後集計を再実行せず参照した案。sameAs の参照先は同じ case・margin・seedSplit・label の中の案を指す（`=full` 等の行を探すときは同じ行の case・margin・seedSplit・label が一致する行を見ること）。'
    + 'marginHits・missedHeldOutCount・presentedCount・fetchedCount・pickedCount・llmTokensIn・llmCostUsd は sameAs の run では測定していないため `=<参照先の案名>` と表示する（0 や - ではない。数値として読まず、参照先の行を見ること）。'
    + 'marginHits は per-block では「ブロック別件数」を `+` で連結した表示で、和集合の件数ではない（重複を含む）。'
    + 'missedStudies は現式で未捕捉の held-out 研究の「研究名:判定@取得<順位|->/深い<順位|->」一覧。取得順位は取得一覧（`retrievedPmids`）での順位、深い順位は rankDepth 件まで別途取得した一覧での順位で、両者は別物（取得一覧に無くても深い取得でだけ順位が付くことがある）。per-block はどのブロックで付いた順位かを `(#ブロックID)` で示す。'
    + 'status=failed の run は各列を「失敗」として表示する。\n\n';
  writeFileSync(join(root, 'summary.md'), context + renderMarkdown(rows));
  process.stdout.write(`${runs.length} 件の run を集計しました -> ${join(root, 'summary.md')}\n`);
}

if (require.main === module) report();
