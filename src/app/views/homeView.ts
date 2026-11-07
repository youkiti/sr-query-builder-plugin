import { t } from '@/lib/i18n';
import { formatFormulaVersionShort } from './formatHelpers';
import { buildHydrateErrorBanner } from './hydrateErrorBanner';
import type { RenderView } from './types';

/**
 * ホーム画面のコールバック。
 * - `onOpenPopup`: 別プロジェクトを選ぶために popup.html を新規タブで開く。
 *   Chrome 拡張コンテキスト外（テスト）では省略可で、ボタン自体は描画される。
 * - `onRetryHydrate`: 起動時 hydrate（Sheets 読み込み）失敗バナーの「再試行」。
 */
export interface HomeViewCallbacks {
  onOpenPopup?: () => void;
  onRetryHydrate?: () => void;
}

/**
 * ホーム画面。プロジェクト概要と、既に採番済みの Protocol / Formula バージョンだけを
 * 要約表示する。初回導線は protocol に寄せるため、未確定の状態はここでは強調しない。
 *
 * 「別のプロジェクトを開く」ボタンは、プロジェクト選択をやり直したいユーザーのため
 * Popup（popup.html）を新規タブで開く。docs/ui-flow.md §4 の「プロジェクト名クリックで
 * Popup に戻る」要件を補完する導線。
 */
export function createHomeView(callbacks: HomeViewCallbacks = {}): RenderView {
  return (container, ctx) => {
    container.innerHTML = '';
    const doc = container.ownerDocument;

    const heading = doc.createElement('h2');
    heading.textContent = t('home.title');
    container.appendChild(heading);

    if (ctx.state.hydrateError !== null) {
      container.appendChild(
        buildHydrateErrorBanner(doc, ctx.state.hydrateError, callbacks.onRetryHydrate)
      );
    }

    const projectInfo = doc.createElement('p');
    if (ctx.state.project) {
      projectInfo.textContent = t('home.project', { title: ctx.state.project.title, id: ctx.state.project.projectId.slice(0, 8) });
    } else {
      projectInfo.textContent = t('home.noProject');
    }
    container.appendChild(projectInfo);

    const summary = doc.createElement('p');
    summary.className = 'home__summary';
    if (!ctx.state.project) {
      summary.textContent = t('home.start');
    } else if (
      ctx.state.currentProtocolVersion === null &&
      ctx.state.currentFormulaVersionId === null
    ) {
      summary.textContent = t('home.overview');
    } else {
      summary.textContent = t('home.versions');
    }
    container.appendChild(summary);

    const statusList = buildStatusList(doc, ctx.state);
    if (statusList) {
      container.appendChild(statusList);
    }

    container.appendChild(buildSwitchProjectAction(doc, callbacks));
  };
}

/** 後方互換: 既存の import { renderHomeView } を壊さない既定インスタンス */
export const renderHomeView: RenderView = createHomeView();

function buildSwitchProjectAction(doc: Document, callbacks: HomeViewCallbacks): HTMLElement {
  const wrap = doc.createElement('p');
  wrap.className = 'home__actions';
  const btn = doc.createElement('button');
  btn.type = 'button';
  btn.className = 'home__switch-project';
  btn.textContent = t('home.switch');
  btn.title = t('home.switchTitle');
  btn.addEventListener('click', () => {
    callbacks.onOpenPopup?.();
  });
  wrap.appendChild(btn);
  return wrap;
}

function buildStatusList(
  doc: Document,
  state: Parameters<RenderView>[1]['state']
): HTMLElement | null {
  const dl = doc.createElement('dl');
  dl.className = 'home__status';

  if (state.currentProtocolVersion !== null) {
    appendEntry(doc, dl, t('home.protocolVersion'), `v${state.currentProtocolVersion}`);
  }
  const formulaShort = formatFormulaVersionShort(state.currentFormulaVersionId);
  if (formulaShort !== null) {
    appendEntry(doc, dl, t('home.formulaVersion'), formulaShort);
  }

  return dl.childElementCount > 0 ? dl : null;
}

function appendEntry(doc: Document, dl: HTMLElement, label: string, value: string): void {
  const dt = doc.createElement('dt');
  dt.textContent = label;
  const dd = doc.createElement('dd');
  dd.textContent = value;
  dl.appendChild(dt);
  dl.appendChild(dd);
}
