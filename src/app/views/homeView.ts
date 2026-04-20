import { ROUTE_LABELS } from '../router';
import { formatFormulaVersionShort } from './formatHelpers';
import type { RenderView } from './types';

/**
 * ホーム画面。プロジェクトの選択状況、現在の Protocol / Formula バージョン、
 * 各ステップへのリンクを表示する（docs/ui-flow.md §2 / §4）。
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

  container.appendChild(buildStatusList(doc, ctx.state));

  const list = doc.createElement('ul');
  list.className = 'home__steps';
  for (const step of ['protocol', 'blocks', 'seeds', 'draft', 'validate'] as const) {
    const li = doc.createElement('li');
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.textContent = ROUTE_LABELS[step];
    btn.addEventListener('click', () => ctx.navigate(step));
    li.appendChild(btn);
    list.appendChild(li);
  }
  container.appendChild(list);
};

function buildStatusList(doc: Document, state: Parameters<RenderView>[1]['state']): HTMLElement {
  const dl = doc.createElement('dl');
  dl.className = 'home__status';

  appendEntry(
    doc,
    dl,
    'Protocol version',
    state.currentProtocolVersion !== null ? `v${state.currentProtocolVersion}` : '未確定'
  );
  const formulaShort = formatFormulaVersionShort(state.currentFormulaVersionId);
  appendEntry(doc, dl, 'Formula version', formulaShort ?? '未生成');
  return dl;
}

function appendEntry(doc: Document, dl: HTMLElement, label: string, value: string): void {
  const dt = doc.createElement('dt');
  dt.textContent = label;
  const dd = doc.createElement('dd');
  dd.textContent = value;
  dl.appendChild(dt);
  dl.appendChild(dd);
}
