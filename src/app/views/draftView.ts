import type { DraftProgress } from '@/app/services';
import { parsePubmedFormulaMd, type PubmedFormula } from '@/lib/search-formula-md';
import { ROUTE_LABELS } from '../router';
import { tokenizeExpression } from './formulaDisplay';
import type { RenderView } from './types';

/**
 * 検索式ドラフト生成画面（#/draft）。
 *
 * - 「生成」ボタンで 4 skill パイプラインを発火
 * - 進捗・エラーは store の state.draftRun から描画する。
 *   LLM コスト集計（cumulativeCostUsd）の setState が走るたびに全ビューが
 *   再描画されるため、ローカル DOM に進捗を書くと最初の LLM 呼び出し完了時点で
 *   表示が消えてしまう（store 保持は validationResult と同じ理由）
 * - 実行中は経過時間を 1 秒ごとに更新して「動いている」ことを示す
 * - 完了後は store.currentFormulaMarkdown を <pre> で表示
 *
 * 実ロジック（generateDraft + draftRun の状態遷移）は bootstrap で差し込み、
 * 本 view は UI 描画のみ。
 */

export interface DraftViewCallbacks {
  /** 「生成」ボタンが押されたとき。進捗・エラーは store.draftRun 経由で反映される */
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
    generateBtn.textContent = running ? '生成中…' : existing ? '再生成する' : '生成する';
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
        status.textContent = runningStatusText(run.progressLabel, run.startedAtMs);
        startElapsedTicker(status, run.progressLabel, run.startedAtMs);
      } else {
        errorBox.textContent = `生成に失敗しました: ${run.error ?? '不明なエラー'}`;
      }
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
function startElapsedTicker(status: HTMLElement, label: string, startedAtMs: number): void {
  const win = status.ownerDocument.defaultView;
  if (!win) {
    return;
  }
  const timer = win.setInterval(() => {
    if (!status.isConnected) {
      win.clearInterval(timer);
      return;
    }
    status.textContent = runningStatusText(label, startedAtMs);
  }, 1000);
}

function runningStatusText(label: string, startedAtMs: number): string {
  return `${label}（経過 ${formatElapsed(Date.now() - startedAtMs)}）`;
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
