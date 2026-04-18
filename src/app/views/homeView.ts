import { ROUTE_LABELS } from '../router';
import type { RenderView } from './types';

/**
 * ホーム画面。プロジェクトの選択状況と、各ステップへのリンクを表示する。
 */
export const renderHomeView: RenderView = (container, ctx) => {
  container.innerHTML = '';

  const heading = container.ownerDocument.createElement('h2');
  heading.textContent = ROUTE_LABELS.home;
  container.appendChild(heading);

  const projectInfo = container.ownerDocument.createElement('p');
  if (ctx.state.project) {
    projectInfo.textContent = `現在のプロジェクト: ${ctx.state.project.title} (${ctx.state.project.projectId.slice(0, 8)})`;
  } else {
    projectInfo.textContent = 'プロジェクトが選択されていません。Popup から作成または選択してください。';
  }
  container.appendChild(projectInfo);

  const list = container.ownerDocument.createElement('ul');
  list.className = 'home__steps';
  for (const step of ['protocol', 'blocks', 'seeds', 'draft', 'validate'] as const) {
    const li = container.ownerDocument.createElement('li');
    const btn = container.ownerDocument.createElement('button');
    btn.type = 'button';
    btn.textContent = ROUTE_LABELS[step];
    btn.addEventListener('click', () => ctx.navigate(step));
    li.appendChild(btn);
    list.appendChild(li);
  }
  container.appendChild(list);
};
