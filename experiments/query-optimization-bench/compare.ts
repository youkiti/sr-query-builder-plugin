import { readFileSync } from 'node:fs';
import { compareMetrics } from './metrics';
import type { RunResult } from './types';

export function loadRun(path: string): RunResult {
  return JSON.parse(readFileSync(path, 'utf8')) as RunResult;
}

/**
 * 2 つの run.json を比較する。C0 が同一の凍結 fixture（sha256 一致）でなければ、
 * 差が自動調整の効果かケース条件の違いか区別できないため比較そのものを拒否する。
 */
export function renderComparison(a: RunResult, b: RunResult): string {
  if (!a.c0 || a.c0.source !== 'frozen' || !a.c0.sha256 || !b.c0 || b.c0.source !== 'frozen' || !b.c0.sha256) {
    throw new Error('両方の run が凍結 C0（--c0）を使っていません。比較には frozen な C0（sha256 付き）が必要です');
  }
  if (a.c0.sha256 !== b.c0.sha256) {
    throw new Error(`C0 の sha256 が一致しません（A=${a.c0.sha256}, B=${b.c0.sha256}）`);
  }
  // 片方だけ固定提案の replay だと、差が自動調整の効果か固定提案の有無かを区別できない。
  if (Boolean(a.replay) !== Boolean(b.replay)) {
    throw new Error('片方だけ replay の run です。比較には両方とも replay か、両方とも自由生成の run が必要です');
  }
  if (a.replay && b.replay && a.replay.sha256 !== b.replay.sha256) {
    throw new Error(`replay の sha256 が一致しません（A=${a.replay.sha256}, B=${b.replay.sha256}）`);
  }
  if (a.id !== b.id) throw new Error(`ケースが一致しません（A=${a.id}, B=${b.id}）`);
  if (a.seedSplit !== b.seedSplit) throw new Error(`シード分割が一致しません（A=${a.seedSplit ?? '欠測'}, B=${b.seedSplit ?? '欠測'}）`);
  if (a.maxHits !== b.maxHits) throw new Error(`maxHits が一致しません（A=${a.maxHits}, B=${b.maxHits}）`);
  if (a.maxIterations !== b.maxIterations) throw new Error(`maxIterations が一致しません（A=${a.maxIterations}, B=${b.maxIterations}）`);
  const lines = [
    `# ${a.id} 比較（C0 sha256=${a.c0.sha256.slice(0, 12)}…, seedSplit=${a.seedSplit ?? '欠測'}, maxHits=${a.maxHits}）`,
    '',
    '| | A | B |',
    '|---|---|---|',
    `| runId | ${a.runId} | ${b.runId} |`,
    `| gitCommit | ${a.gitCommit ?? '欠測'} | ${b.gitCommit ?? '欠測'} |`,
  ];
  for (const field of ['label', 'model', 'gitDirty', 'postHoc'] as const) {
    lines.push(`| ${field} | ${a[field] ?? '欠測'} | ${b[field] ?? '欠測'} |`);
  }
  const am = a.conditions.C1?.metrics;
  const bm = b.conditions.C1?.metrics;
  const summarize = (run: RunResult, metrics: typeof am) => metrics
    ? `${metrics.hits} / ${metrics.heldOutRecall ?? '欠測'}`
    : run.conditions.C1 ? '指標なし（要手動監査または失敗）' : '未計測';
  lines.push(`| C1 hits / heldOutRecall | ${summarize(a, am)} | ${summarize(b, bm)} |`, '');
  if (a.model !== b.model) lines.push('⚠ モデルが異なるため、差にはモデルの違いが混ざる', '');
  if (a.gitDirty === true || b.gitDirty === true) lines.push('⚠ 作業ツリーが汚れた状態の run を含む', '');
  if (am && bm) {
    const comparison = compareMetrics(am, bm);
    lines.push('## A → B の差分',
      `- 失った研究: ${comparison.lostStudies.join('; ') || 'なし'}`,
      `- 得た研究: ${comparison.gainedStudies.join('; ') || 'なし'}`,
      `- 失った held-out 研究: ${comparison.lostHeldOut.join('; ') || 'なし'}`,
      `- 得た held-out 研究: ${comparison.gainedHeldOut.join('; ') || 'なし'}`,
      `- outcome: ${comparison.outcome}`);
  } else {
    lines.push('指標が欠けているため比較できません（要手動監査または失敗のいずれか）。');
  }
  return lines.join('\n') + '\n';
}

export function main(args = process.argv.slice(2)): void {
  const [pathA, pathB] = args;
  if (!pathA || !pathB || args.length !== 2) throw new Error('使い方: eval:compare -- <runA.json> <runB.json>');
  process.stdout.write(renderComparison(loadRun(pathA), loadRun(pathB)));
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
