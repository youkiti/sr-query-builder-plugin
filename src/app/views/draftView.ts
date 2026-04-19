import type { DraftProgress } from '@/app/services';
import { ROUTE_LABELS } from '../router';
import type { RenderView } from './types';

/**
 * 検索式ドラフト生成画面（#/draft）。
 *
 * - 「生成」ボタンで 4 skill パイプラインを発火
 * - 進捗テキスト（どの skill を処理中か）を表示
 * - 完了後は store.currentFormulaMarkdown を <pre> で表示
 * - エラー時はエラーボックスに表示
 *
 * 実ロジック（submitDraft）は bootstrap で差し込み、本 view は UI + 進捗表示のみ。
 */

export interface DraftViewCallbacks {
  /** 「生成」ボタンが押されたとき。onProgress が続けて呼ばれる */
  onGenerate?: (onProgress: (p: DraftProgress) => void) => Promise<void>;
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
      const pre = doc.createElement('pre');
      pre.className = 'draft__formula';
      pre.textContent = existing;
      container.appendChild(pre);
    }

    const actions = doc.createElement('div');
    actions.className = 'draft__actions';
    const generateBtn = doc.createElement('button');
    generateBtn.type = 'button';
    generateBtn.textContent = existing ? '再生成する' : '生成する';
    actions.appendChild(generateBtn);
    container.appendChild(actions);

    const status = doc.createElement('p');
    status.className = 'draft__status';
    status.setAttribute('aria-live', 'polite');
    container.appendChild(status);

    const errorBox = doc.createElement('p');
    errorBox.className = 'draft__error';
    errorBox.setAttribute('aria-live', 'polite');
    container.appendChild(errorBox);

    generateBtn.addEventListener('click', () => {
      if (!callbacks.onGenerate) {
        return;
      }
      generateBtn.disabled = true;
      status.textContent = '開始します…';
      errorBox.textContent = '';
      callbacks
        .onGenerate((progress) => {
          status.textContent = formatProgress(progress);
        })
        .then(() => {
          status.textContent = '完了しました。結果を表示中…';
        })
        .catch((err: unknown) => {
          errorBox.textContent = formatError(err);
          status.textContent = '';
        })
        .finally(() => {
          generateBtn.disabled = false;
        });
    });
  };
}

function formatProgress(progress: DraftProgress): string {
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

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
