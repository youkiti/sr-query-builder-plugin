import type { DraftBlockHit, DraftProgress } from '@/app/services';
import { parsePubmedFormulaMd, type PubmedFormula } from '@/lib/search-formula-md';
import { ROUTE_LABELS } from '../router';
import type { AppState } from '../store';
import { tokenizeExpression } from './formulaDisplay';
import type { RenderView } from './types';
import {
  readStoredAnalysis,
  readStoredSummary,
  renderValidationResults,
  summaryStatusText,
  type ValidationResultsCallbacks,
} from './validationResults';

/**
 * 検索式の生成・検証画面（#/draft）。
 *
 * 旧 draft タブと validate タブを統合したもので、1 つの「生成して検証する」操作で
 *   ① ブロックごとに block-designer → mesh → freeword を実行し、出来上がった瞬間に
 *      そのブロックのヒット数（line_hits）を計測してライブ表示する
 *   ② 全ブロックの組み立て・保存後、捕捉率（final_query）・MeSH・階層の検証を自動実行する
 * を続けて行う。
 *
 * - 進捗・エラー・ブロックごとのヒット数は store の state.draftRun から描画する。
 *   LLM コスト集計（cumulativeCostUsd）の setState が走るたびに全ビューが再描画されるため、
 *   ローカル DOM に進捗を書くと最初の LLM 呼び出し完了時点で表示が消えてしまう。
 * - 検証結果は state.validationResult / state.missedAnalysis から復元して表示する。
 * - 実行中は経過時間を 1 秒ごとに更新して「動いている」ことを示す。
 *
 * 実ロジック（generateDraft + runValidation の連結と draftRun の状態遷移）は bootstrap で
 * 差し込み、本 view は UI 描画のみ。
 */

export interface DraftViewCallbacks extends ValidationResultsCallbacks {
  /** 「生成して検証する」ボタンが押されたとき。進捗・エラーは store.draftRun 経由で反映される */
  onGenerate?: () => Promise<void>;
}

export function createDraftView(callbacks: DraftViewCallbacks = {}): RenderView {
  return (container, ctx) => {
    container.innerHTML = '';
    const doc = container.ownerDocument;
    const heading = doc.createElement('h2');
    heading.textContent = ROUTE_LABELS.draft;
    container.appendChild(heading);

    if (!ctx.state.project) {
      const warn = doc.createElement('p');
      warn.className = 'view__placeholder';
      warn.textContent = '先にプロジェクトを選択してください。';
      container.appendChild(warn);
      return;
    }
    if (!ctx.state.blocksDraft) {
      const warn = doc.createElement('p');
      warn.className = 'view__placeholder';
      warn.textContent = 'ブロック承認を先に済ませてください。';
      container.appendChild(warn);
      return;
    }

    const existing = ctx.state.currentFormulaMarkdown;
    if (existing) {
      const info = doc.createElement('p');
      info.className = 'draft__info';
      info.textContent = `現在の version: ${ctx.state.currentFormulaVersionId ?? '(未保存)'}`;
      container.appendChild(info);
      container.appendChild(renderFormula(doc, existing));
    }

    const run = ctx.state.draftRun;
    const running = run?.status === 'running';

    const actions = doc.createElement('div');
    actions.className = 'draft__actions';
    const generateBtn = doc.createElement('button');
    generateBtn.type = 'button';
    generateBtn.textContent = running
      ? '実行中…'
      : existing
        ? '再生成して再検証する'
        : '生成して検証する';
    generateBtn.disabled = running;
    actions.appendChild(generateBtn);
    container.appendChild(actions);

    const status = doc.createElement('p');
    status.className = 'draft__status';
    status.setAttribute('aria-live', 'polite');
    container.appendChild(status);

    const errorBox = doc.createElement('p');
    errorBox.className = 'draft__error';
    errorBox.setAttribute('role', 'alert');
    container.appendChild(errorBox);

    if (run) {
      if (run.status === 'running') {
        status.textContent = runningStatusText(run.phase, run.progressLabel, run.startedAtMs);
        startElapsedTicker(status, run.phase, run.progressLabel, run.startedAtMs);
      } else {
        const phaseLabel = run.phase === 'validating' ? '検証' : '生成';
        errorBox.textContent = `${phaseLabel}に失敗しました: ${run.error ?? '不明なエラー'}`;
      }
    }

    // ブロックごとのライブヒット数。実行中（生成フェーズ）に「出来上がったブロックから順に
    // 件数が出る」様子を見せる。生成済みの blockHits が残っていれば完了後も表示する。
    const blockHits = run?.blockHits ?? [];
    if (blockHits.length > 0 || running) {
      container.appendChild(renderLiveBlockHits(doc, ctx.state, blockHits, running));
    }

    // 検証結果（捕捉率 / MeSH / 階層）。生成完了後に自動実行され store に保存される。
    const storedSummary = readStoredSummary(ctx.state);
    if (storedSummary && !running) {
      const summaryStatus = doc.createElement('p');
      summaryStatus.className = 'draft__validate-status';
      summaryStatus.textContent = summaryStatusText(storedSummary);
      container.appendChild(summaryStatus);

      const results = doc.createElement('div');
      results.className = 'validate__results';
      container.appendChild(results);
      renderValidationResults(doc, results, storedSummary, callbacks, readStoredAnalysis(ctx.state));
    }

    generateBtn.addEventListener('click', () => {
      if (!callbacks.onGenerate || generateBtn.disabled) {
        return;
      }
      // 状態遷移（draftRun の running 設定）は bootstrap 側。setState → 再描画で
      // ボタンが即座に無効化されるため、ここでのローカル無効化は保険のみ
      generateBtn.disabled = true;
      void callbacks.onGenerate();
    });
  };
}

/**
 * ブロックごとのヒット数のライブ一覧。
 * blocksDraft のブロック定義を基準に、計測済み（blockHits）があれば件数を、
 * まだなら実行中は「計測中…」、停止後は何も足さずに表示する。
 */
function renderLiveBlockHits(
  doc: Document,
  state: AppState,
  blockHits: DraftBlockHit[],
  running: boolean
): HTMLElement {
  const section = doc.createElement('section');
  section.className = 'draft__block-hits';
  const h3 = doc.createElement('h3');
  h3.textContent = 'ブロックごとのヒット数';
  section.appendChild(h3);

  const byIndex = new Map<number, DraftBlockHit>();
  for (const hit of blockHits) {
    byIndex.set(hit.blockIndex, hit);
  }

  const labels = state.blocksDraft?.blocks ?? [];
  const ul = doc.createElement('ul');
  labels.forEach((block, index) => {
    const li = doc.createElement('li');
    const hit = byIndex.get(index);
    const label = block.blockLabel || `ブロック ${index + 1}`;
    if (hit && hit.error !== null) {
      li.className = 'draft__block-hit draft__block-hit--error';
      li.textContent = `#${index + 1} ${label}: エラー — ${hit.error}`;
    } else if (hit && hit.hitCount !== null) {
      li.className = 'draft__block-hit draft__block-hit--done';
      li.textContent = `#${index + 1} ${label}: ${hit.hitCount.toLocaleString()} 件`;
    } else if (running) {
      li.className = 'draft__block-hit draft__block-hit--pending';
      li.textContent = `#${index + 1} ${label}: 計測中…`;
    } else {
      li.className = 'draft__block-hit draft__block-hit--pending';
      li.textContent = `#${index + 1} ${label}: —`;
    }
    ul.appendChild(li);
  });
  section.appendChild(ul);
  return section;
}

/**
 * 検索式 markdown をブロック単位で描画する。
 * - 1 行が長いため折り返す（CSS の white-space: pre-wrap / overflow-wrap）
 * - `#N` ごとにカードとして区切り、結合行（`#3 #1 AND #2`）は別スタイル
 * - 語のフィールドタグを見て MeSH / フリーワードを薄く色分けする
 *
 * パースに失敗した場合（PubMed セクション欠落など）は生テキストの <pre> に
 * フォールバックする。
 */
function renderFormula(doc: Document, markdown: string): HTMLElement {
  let formula: PubmedFormula | null = null;
  try {
    formula = parsePubmedFormulaMd(markdown);
  } catch {
    formula = null;
  }

  if (!formula || formula.blocks.length === 0) {
    const pre = doc.createElement('pre');
    pre.className = 'draft__formula draft__formula--raw';
    pre.textContent = markdown;
    return pre;
  }

  const wrap = doc.createElement('div');
  wrap.className = 'draft__formula';

  for (const block of formula.blocks) {
    const row = doc.createElement('div');
    row.className = 'draft__block';
    if (block.isCombination) {
      row.classList.add('draft__block--combination');
    }

    const id = doc.createElement('span');
    id.className = 'draft__block-id';
    id.textContent = `#${block.id}`;
    row.appendChild(id);

    const expr = doc.createElement('div');
    expr.className = 'draft__block-expr';
    for (const segment of tokenizeExpression(block.expression)) {
      if (segment.kind === 'plain') {
        expr.appendChild(doc.createTextNode(segment.text));
      } else {
        const span = doc.createElement('span');
        span.className = `draft__term draft__term--${segment.kind}`;
        span.textContent = segment.text;
        expr.appendChild(span);
      }
    }
    row.appendChild(expr);
    wrap.appendChild(row);
  }

  wrap.appendChild(buildLegend(doc));
  return wrap;
}

/** MeSH / フリーワードの色分け凡例 */
function buildLegend(doc: Document): HTMLElement {
  const legend = doc.createElement('div');
  legend.className = 'draft__legend';
  for (const [kind, label] of [
    ['mesh', 'MeSH'],
    ['freeword', 'フリーワード'],
  ] as const) {
    const item = doc.createElement('span');
    item.className = `draft__legend-item draft__term--${kind}`;
    item.textContent = label;
    legend.appendChild(item);
  }
  return legend;
}

/**
 * 実行中ステータスの 1 秒ごとの経過時間更新。
 * 再描画されると要素ごと DOM から外れるので、isConnected を見て自動停止する
 * （再描画後は新しい要素に対して新しい ticker が走る）。
 */
function startElapsedTicker(
  status: HTMLElement,
  phase: DraftRunPhase,
  label: string,
  startedAtMs: number
): void {
  const win = status.ownerDocument.defaultView;
  if (!win) {
    return;
  }
  const timer = win.setInterval(() => {
    if (!status.isConnected) {
      win.clearInterval(timer);
      return;
    }
    status.textContent = runningStatusText(phase, label, startedAtMs);
  }, 1000);
}

type DraftRunPhase = 'generating' | 'validating';

function runningStatusText(phase: DraftRunPhase, label: string, startedAtMs: number): string {
  const phaseLabel = phase === 'validating' ? '検証' : '生成';
  return `[${phaseLabel}] ${label}（経過 ${formatElapsed(Date.now() - startedAtMs)}）`;
}

function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return min > 0 ? `${min}分${sec}秒` : `${sec}秒`;
}

/** DraftProgress を表示用ラベルへ変換する（bootstrap が draftRun.progressLabel に入れる） */
export function formatDraftProgress(progress: DraftProgress): string {
  const label = {
    'block-designer': 'ブロック骨格を設計中',
    'mesh-suggester': 'MeSH を提案中',
    'freeword-designer': 'フリーワードを展開中',
    'line-hits': 'ブロックのヒット数を計測中',
    'filter-designer': 'フィルタを決定中',
    assemble: '検索式を組み立て中',
    save: 'FormulaVersions に保存中',
    done: '完了',
  }[progress.step];
  if (progress.blockIndex !== undefined) {
    return `${label}（ブロック ${progress.blockIndex + 1}/${progress.blockCount}）`;
  }
  return label;
}

export { formatValidationProgress } from './validationResults';
