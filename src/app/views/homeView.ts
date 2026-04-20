import { ROUTE_LABELS } from '../router';
import { formatFormulaVersionShort } from './formatHelpers';
import type { RenderView } from './types';

/**
 * ホーム画面。プロジェクト概要と、既に採番済みの Protocol / Formula バージョンだけを
 * 要約表示する。初回導線は protocol に寄せるため、未確定の状態はここでは強調しない。
 */
export const renderHomeView: RenderView = (container, ctx) => {
  container.innerHTML = '';
  const doc = container.ownerDocument;

  const heading = doc.createElement('h2');
  heading.textContent = ROUTE_LABELS.home;
  container.appendChild(heading);

  const projectInfo = doc.createElement('p');
  if (ctx.state.project) {
    projectInfo.textContent = `現在のプロジェクト: ${ctx.state.project.title} (${ctx.state.project.projectId.slice(0, 8)})`;
  } else {
    projectInfo.textContent = 'プロジェクトが選択されていません。Popup から作成または選択してください。';
  }
  container.appendChild(projectInfo);

  const summary = doc.createElement('p');
  summary.className = 'home__summary';
  if (!ctx.state.project) {
    summary.textContent = '最初に Popup でプロジェクトを選択すると、プロトコル入力から開始できます。';
  } else if (
    ctx.state.currentProtocolVersion === null &&
    ctx.state.currentFormulaVersionId === null
  ) {
    summary.textContent = 'この画面は概要のみです。作業は左の「プロトコル入力」から始めてください。';
  } else {
    summary.textContent = '現在採番済みのバージョン概要です。';
  }
  container.appendChild(summary);

  const statusList = buildStatusList(doc, ctx.state);
  if (statusList) {
    container.appendChild(statusList);
  }
};

function buildStatusList(
  doc: Document,
  state: Parameters<RenderView>[1]['state']
): HTMLElement | null {
  const dl = doc.createElement('dl');
  dl.className = 'home__status';

  if (state.currentProtocolVersion !== null) {
    appendEntry(doc, dl, 'Protocol version', `v${state.currentProtocolVersion}`);
  }
  const formulaShort = formatFormulaVersionShort(state.currentFormulaVersionId);
  if (formulaShort !== null) {
    appendEntry(doc, dl, 'Formula version', formulaShort);
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
