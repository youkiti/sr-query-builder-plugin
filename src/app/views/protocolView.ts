import { ROUTE_LABELS } from '../router';
import type { RenderView } from './types';

/**
 * プロトコル入力フォーム（手入力 / .md / .docx）。
 *
 * MVP のこの段階ではフォーム UI のみ提供し、実際の送信処理（features/protocol
 * パーサ呼び出し → extract-protocol skill → ブロック承認画面遷移）は
 * 後続の wiring セッションで bootstrap.ts から組み合わせる。
 */
export const renderProtocolView: RenderView = (container, ctx) => {
  container.innerHTML = '';

  const heading = container.ownerDocument.createElement('h2');
  heading.textContent = ROUTE_LABELS.protocol;
  container.appendChild(heading);

  if (!ctx.state.project) {
    const warn = container.ownerDocument.createElement('p');
    warn.className = 'protocol__warning';
    warn.textContent = '先にプロジェクトを選択してください。';
    container.appendChild(warn);
    return;
  }

  const form = container.ownerDocument.createElement('form');
  form.className = 'protocol__form';
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    // 実送信は後続セッションで bootstrap.ts から差し込む
  });

  form.appendChild(buildSection(container.ownerDocument, '入力形式', buildSourceTypeRadios));
  form.appendChild(buildField(container.ownerDocument, 'rq', 'RQ（リサーチクエスチョン）'));
  form.appendChild(buildField(container.ownerDocument, 'inclusion', '組入基準（改行区切り）'));
  form.appendChild(buildField(container.ownerDocument, 'exclusion', '除外基準（改行区切り）'));
  form.appendChild(buildField(container.ownerDocument, 'inline', '元テキスト（手入力時のみ）'));
  form.appendChild(buildFileInput(container.ownerDocument, 'file', '.md / .docx アップロード'));

  const submit = container.ownerDocument.createElement('button');
  submit.type = 'submit';
  submit.textContent = '次へ（ブロック抽出）';
  form.appendChild(submit);

  container.appendChild(form);
};

function buildSection(
  doc: Document,
  legend: string,
  builder: (doc: Document) => HTMLElement
): HTMLElement {
  const fs = doc.createElement('fieldset');
  const lg = doc.createElement('legend');
  lg.textContent = legend;
  fs.appendChild(lg);
  fs.appendChild(builder(doc));
  return fs;
}

function buildSourceTypeRadios(doc: Document): HTMLElement {
  const wrap = doc.createElement('div');
  for (const value of ['manual', 'markdown', 'docx'] as const) {
    const label = doc.createElement('label');
    const input = doc.createElement('input');
    input.type = 'radio';
    input.name = 'sourceType';
    input.value = value;
    if (value === 'manual') {
      input.checked = true;
    }
    label.appendChild(input);
    label.appendChild(doc.createTextNode(` ${value}`));
    wrap.appendChild(label);
  }
  return wrap;
}

function buildField(doc: Document, id: string, label: string): HTMLElement {
  const wrap = doc.createElement('label');
  wrap.className = 'protocol__field';
  const span = doc.createElement('span');
  span.textContent = label;
  wrap.appendChild(span);
  const control = doc.createElement('textarea');
  control.id = id;
  wrap.appendChild(control);
  return wrap;
}

function buildFileInput(doc: Document, id: string, label: string): HTMLElement {
  const wrap = doc.createElement('label');
  wrap.className = 'protocol__file';
  const span = doc.createElement('span');
  span.textContent = label;
  wrap.appendChild(span);
  const input = doc.createElement('input');
  input.type = 'file';
  input.id = id;
  input.accept = '.md,.markdown,.docx';
  wrap.appendChild(input);
  return wrap;
}
