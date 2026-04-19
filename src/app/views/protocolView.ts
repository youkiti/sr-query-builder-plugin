import type { ProtocolSubmissionInput } from '@/app/services';
import { ROUTE_LABELS } from '../router';
import type { RenderView } from './types';

/**
 * プロトコル入力フォーム（手入力 / .md / .docx）。
 *
 * 送信時は `onSubmit` callback に `ProtocolSubmissionInput` を渡し、
 * 実呼び出し（features/protocol パーサ → extract-protocol skill →
 * blocksDraft 更新 → /blocks ナビ）は bootstrap.ts 側で組み立てる。
 */

export interface ProtocolViewCallbacks {
  onSubmit?: (input: ProtocolSubmissionInput) => void | Promise<void>;
}

export function createProtocolView(callbacks: ProtocolViewCallbacks = {}): RenderView {
  return (container, ctx) => {
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

    const doc = container.ownerDocument;
    const form = doc.createElement('form');
    form.className = 'protocol__form';

    form.appendChild(buildSection(doc, '入力形式', buildSourceTypeRadios));
    form.appendChild(buildField(doc, 'rq', 'RQ（リサーチクエスチョン）'));
    form.appendChild(buildField(doc, 'inclusion', '組入基準（改行区切り）'));
    form.appendChild(buildField(doc, 'exclusion', '除外基準（改行区切り）'));
    form.appendChild(buildField(doc, 'inline', '元テキスト（手入力時のみ）'));
    form.appendChild(buildFileInput(doc, 'file', '.md / .docx アップロード'));

    const submit = doc.createElement('button');
    submit.type = 'submit';
    submit.textContent = '次へ（ブロック抽出）';
    form.appendChild(submit);

    const errorBox = doc.createElement('p');
    errorBox.className = 'protocol__error';
    errorBox.id = 'protocol-error';
    errorBox.setAttribute('aria-live', 'polite');
    form.appendChild(errorBox);

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      errorBox.textContent = '';
      try {
        const input = collectFormInput(form);
        submit.disabled = true;
        void Promise.resolve(callbacks.onSubmit?.(input))
          .catch((err: unknown) => {
            errorBox.textContent = formatError(err);
          })
          .finally(() => {
            submit.disabled = false;
          });
      } catch (err) {
        errorBox.textContent = formatError(err);
      }
    });

    container.appendChild(form);
  };
}

/**
 * 旧 API（callback 無し）。テストや placeholder 用途で残す。
 * 実際の wiring は createProtocolView を使う。
 */
export const renderProtocolView: RenderView = createProtocolView();

function collectFormInput(form: HTMLFormElement): ProtocolSubmissionInput {
  const sourceType = readSourceType(form);
  const rq = readField(form, 'rq');
  const inclusion = readField(form, 'inclusion');
  const exclusion = readField(form, 'exclusion');
  const inline = readField(form, 'inline');
  const fileInput = form.querySelector<HTMLInputElement>('input[type=file]');
  const file = fileInput?.files?.[0] ?? null;
  const base: ProtocolSubmissionInput = {
    sourceType,
    researchQuestion: rq,
    inclusionCriteria: inclusion,
    exclusionCriteria: exclusion,
    inlineText: inline,
  };
  if (sourceType === 'markdown') {
    if (!file) {
      throw new Error('markdown ファイルを選択してください');
    }
    return { ...base, markdownFile: { name: file.name, text: () => file.text() } };
  }
  if (sourceType === 'docx') {
    if (!file) {
      throw new Error('.docx ファイルを選択してください');
    }
    return {
      ...base,
      docxFile: { name: file.name, arrayBuffer: () => file.arrayBuffer() },
    };
  }
  return base;
}

function readSourceType(form: HTMLFormElement): ProtocolSubmissionInput['sourceType'] {
  const checked = form.querySelector<HTMLInputElement>('input[name=sourceType]:checked');
  const value = checked?.value;
  if (value === 'markdown' || value === 'docx') return value;
  return 'manual';
}

function readField(form: HTMLFormElement, id: string): string {
  // 同モジュール内の buildField で必ず作っているので非 null 想定
  return (form.querySelector(`textarea#${id}`) as HTMLTextAreaElement).value;
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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
