import type { FormulaVersion } from '@/domain/formulaVersion';
import { buildCodeBlockPreview } from '@/utils/markdown';
import { ROUTE_LABELS } from '../router';
import type { RenderView } from './types';

/**
 * 検索式バージョン履歴画面（#/history）。
 *
 * - FormulaVersions タブから全履歴を新しい順で取得して一覧表示
 * - 各行に「このバージョンを読み込む」ボタンがあり、store の
 *   currentFormulaVersionId / currentFormulaMarkdown を差し替える
 * - 現在読み込み中のバージョンはバッジ表示
 *
 * 実ロジック（onList / onLoad）は bootstrap で formulaRepository をラップして渡す。
 */

export interface HistoryViewCallbacks {
  onList?: () => Promise<FormulaVersion[]>;
  onLoad?: (version: FormulaVersion) => void;
}

export function createHistoryView(callbacks: HistoryViewCallbacks = {}): RenderView {
  return (container, ctx) => {
    container.innerHTML = '';
    const doc = container.ownerDocument;
    const heading = doc.createElement('h2');
    heading.textContent = ROUTE_LABELS.history;
    container.appendChild(heading);

    if (!ctx.state.project) {
      const warn = doc.createElement('p');
      warn.className = 'view__placeholder';
      warn.textContent = '先にプロジェクトを選択してください。';
      container.appendChild(warn);
      return;
    }

    const status = doc.createElement('p');
    status.className = 'history__status';
    status.setAttribute('aria-live', 'polite');
    status.textContent = '履歴を読み込み中…';
    container.appendChild(status);

    const errorBox = doc.createElement('p');
    errorBox.className = 'history__error';
    errorBox.setAttribute('aria-live', 'polite');
    container.appendChild(errorBox);

    const list = doc.createElement('ul');
    list.className = 'history__list';
    container.appendChild(list);

    if (!callbacks.onList) {
      status.textContent = '';
      return;
    }

    callbacks
      .onList()
      .then((versions) => {
        if (versions.length === 0) {
          status.textContent = 'まだバージョンが登録されていません。';
          return;
        }
        status.textContent = `${versions.length} 件のバージョンが見つかりました。`;
        for (const v of versions) {
          list.appendChild(buildItem(doc, v, ctx.state.currentFormulaVersionId, callbacks.onLoad));
        }
      })
      .catch((err: unknown) => {
        errorBox.textContent = formatError(err);
        status.textContent = '';
      });
  };
}

function buildItem(
  doc: Document,
  version: FormulaVersion,
  activeVersionId: string | null,
  onLoad: HistoryViewCallbacks['onLoad']
): HTMLElement {
  const li = doc.createElement('li');
  li.className = 'history__item';
  li.dataset['versionId'] = version.versionId;

  const head = doc.createElement('p');
  head.className = 'history__head';
  const idSpan = doc.createElement('strong');
  idSpan.textContent = version.versionId;
  head.appendChild(idSpan);
  const metaSpan = doc.createElement('span');
  metaSpan.className = 'history__meta';
  const parent = version.parentVersionId ? ` ← ${version.parentVersionId}` : '';
  metaSpan.textContent = ` / ${version.createdBy} / ${version.createdAt}${parent}`;
  head.appendChild(metaSpan);
  if (version.versionId === activeVersionId) {
    const badge = doc.createElement('span');
    badge.className = 'history__badge';
    badge.textContent = '読み込み中';
    head.appendChild(badge);
  }
  li.appendChild(head);

  if (version.note !== null && version.note !== '') {
    const note = doc.createElement('p');
    note.className = 'history__note';
    note.textContent = version.note;
    li.appendChild(note);
  }

  const preview = doc.createElement('pre');
  preview.className = 'history__preview';
  preview.textContent = buildCodeBlockPreview(version.formulaMd);
  li.appendChild(preview);

  const btn = doc.createElement('button');
  btn.type = 'button';
  btn.className = 'history__load';
  btn.textContent = 'このバージョンを読み込む';
  btn.addEventListener('click', () => {
    if (onLoad) {
      onLoad(version);
    }
  });
  li.appendChild(btn);
  return li;
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
