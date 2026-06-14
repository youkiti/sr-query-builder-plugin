import type { RestoreFormulaResult } from '@/app/services';
import type { FormulaVersion } from '@/domain/formulaVersion';
import { ROUTE_LABELS } from '../router';
import type { RenderView } from './types';

/**
 * 検索式バージョン履歴画面（#/history）。
 *
 * - FormulaVersions タブから全履歴を新しい順で取得して一覧表示
 * - 各行に「このバージョンを復元」ボタンがあり、その内容を**新しい作業バージョンとして
 *   フォーク**してから読み込む（元の履歴行は無傷のまま。動的上書き保存と両立させるため）
 * - 現在読み込み中のバージョンはバッジ表示し、復元ボタンは無効化する
 *
 * 実ロジック（onList / onLoad）は bootstrap で formulaRepository / editService をラップして渡す。
 */

export interface HistoryViewCallbacks {
  onList?: () => Promise<FormulaVersion[]>;
  /** 選択バージョンを復元する。新しい作業バージョンへフォークして読み込む（restoreFormulaVersion） */
  onLoad?: (version: FormulaVersion) => void | Promise<RestoreFormulaResult>;
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

    const lede = doc.createElement('p');
    lede.className = 'history__lede';
    lede.textContent =
      '「このバージョンを復元」を押すと、その内容を新しい作業バージョンとして複製してから読み込みます。選んだ過去バージョンの履歴行はそのまま残ります。';
    container.appendChild(lede);

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
          list.appendChild(
            buildItem(doc, v, ctx.state.currentFormulaVersionId, callbacks.onLoad, errorBox)
          );
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
  onLoad: HistoryViewCallbacks['onLoad'],
  errorBox: HTMLElement
): HTMLElement {
  const li = doc.createElement('li');
  li.className = 'history__item';
  li.dataset['versionId'] = version.versionId;
  const isActive = version.versionId === activeVersionId;

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
  if (isActive) {
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
  preview.textContent = buildPreview(version.formulaMd);
  li.appendChild(preview);

  const btn = doc.createElement('button');
  btn.type = 'button';
  btn.className = 'history__load';
  if (isActive) {
    // 既に読み込み中のバージョンは復元（フォーク）の意味がないので無効化する
    btn.textContent = '読み込み中';
    btn.disabled = true;
  } else {
    btn.textContent = 'このバージョンを復元';
    btn.addEventListener('click', () => {
      if (!onLoad) {
        return;
      }
      errorBox.textContent = '';
      btn.disabled = true;
      btn.textContent = '復元中…';
      // 成功時は store 更新 → 再描画でこのボタンごと作り直されるため、ここでは復帰処理は不要。
      // 失敗時のみ（store が変わらず再描画されない）この場でエラーを出して再度押せるようにする。
      Promise.resolve(onLoad(version)).catch((err: unknown) => {
        errorBox.textContent = `復元に失敗しました: ${formatError(err)}`;
        btn.disabled = false;
        btn.textContent = 'このバージョンを復元';
      });
    });
  }
  li.appendChild(btn);
  return li;
}

function buildPreview(md: string): string {
  const lines = md.split('\n');
  const head = lines.slice(0, 10).join('\n');
  return lines.length > 10 ? `${head}\n…` : head;
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
