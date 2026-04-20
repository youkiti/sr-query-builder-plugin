import type { ProtocolSubmissionInput } from '@/app/services';
import { ROUTE_LABELS } from '../router';
import type { RenderView } from './types';

/**
 * プロトコル入力フォーム。
 *
 * 要件 §4.2 に基づき、入力形式は 3 系統で排他：
 *   - manual   : プロトコル全文の 1 つのテキストエリア
 *   - markdown : `.md` ファイル 1 つ
 *   - docx     : `.docx` ファイル 1 つ
 *
 * RQ / 組入 / 除外基準は LLM (`extract-protocol` skill) が元テキストから
 * 自動抽出するため、入力フォーム側には持たせない（次の「ブロック承認」画面で編集する）。
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
    const doc = container.ownerDocument;

    const heading = doc.createElement('h2');
    heading.textContent = ROUTE_LABELS.protocol;
    container.appendChild(heading);

    const lead = doc.createElement('p');
    lead.className = 'protocol__lead';
    lead.textContent =
      '最初にレビュー対象のプロトコルを入力します。手入力、Markdown、Word (.docx) のいずれでも開始できます。';
    container.appendChild(lead);

    if (!ctx.state.project) {
      const warn = doc.createElement('p');
      warn.className = 'protocol__warning';
      warn.textContent = '先にプロジェクトを選択してください。';
      container.appendChild(warn);
      return;
    }

    const project = doc.createElement('p');
    project.className = 'protocol__project';
    project.textContent = `現在のプロジェクト: ${ctx.state.project.title}`;
    container.appendChild(project);

    const form = doc.createElement('form');
    form.className = 'protocol__form';

    const sourceSection = buildSection(doc, '入力形式', buildSourceTypeRadios);
    form.appendChild(sourceSection);

    const manualSection = buildSection(doc, '手入力', (sectionDoc) => {
      const wrap = sectionDoc.createElement('div');
      wrap.className = 'protocol__section';
      const hint = sectionDoc.createElement('p');
      hint.className = 'protocol__hint';
      hint.textContent =
        'プロトコル全文を貼り付けてください。RQ・組入/除外基準・ブロックは AI が自動抽出し、' +
        '次の「ブロック承認」画面で編集できます。';
      wrap.appendChild(hint);
      wrap.appendChild(buildField(sectionDoc, 'inline', 'プロトコル全文'));
      return wrap;
    });
    form.appendChild(manualSection);

    const fileField = buildFileInput(doc, 'file', 'プロトコルファイル');
    const fileInput = fileField.querySelector<HTMLInputElement>('input[type=file]')!;
    const fileSection = buildSection(doc, 'ファイル入力', (sectionDoc) => {
      const wrap = sectionDoc.createElement('div');
      wrap.className = 'protocol__section';
      const hint = sectionDoc.createElement('p');
      hint.className = 'protocol__hint';
      hint.dataset.role = 'file-hint';
      wrap.appendChild(hint);
      wrap.appendChild(fileField);
      return wrap;
    });
    form.appendChild(fileSection);

    const submit = doc.createElement('button');
    submit.type = 'submit';
    submit.className = 'protocol__submit';
    form.appendChild(submit);

    const errorBox = doc.createElement('p');
    errorBox.className = 'protocol__error';
    errorBox.id = 'protocol-error';
    errorBox.setAttribute('aria-live', 'polite');
    form.appendChild(errorBox);

    const syncMode = (): void => {
      const sourceType = readSourceType(form);
      const isManual = sourceType === 'manual';
      manualSection.hidden = !isManual;
      fileSection.hidden = isManual;
      const hint = form.querySelector<HTMLElement>('[data-role=file-hint]');
      if (sourceType === 'markdown') {
        fileInput.accept = '.md,.markdown';
        if (hint) {
          hint.textContent = '解析したい Markdown のプロトコルファイルを選択してください。';
        }
        submit.textContent = 'Markdown を解析してブロック抽出へ';
        return;
      }
      if (sourceType === 'docx') {
        fileInput.accept = '.docx';
        if (hint) {
          hint.textContent = '解析したい Word (.docx) のプロトコルファイルを選択してください。';
        }
        submit.textContent = 'Word ファイルを解析してブロック抽出へ';
        return;
      }
      fileInput.accept = '.md,.markdown,.docx';
      submit.textContent = '入力内容を解析してブロック抽出へ';
    };

    const sourceInputs = form.querySelectorAll<HTMLInputElement>('input[name=sourceType]');
    sourceInputs.forEach((input) => input.addEventListener('change', syncMode));
    syncMode();

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
  if (sourceType === 'manual') {
    const inline = readField(form, 'inline');
    if (!inline.trim()) {
      throw new Error('プロトコル全文を入力してください');
    }
    return { sourceType, inlineText: inline };
  }
  const fileInput = form.querySelector<HTMLInputElement>('input[type=file]');
  const file = fileInput?.files?.[0] ?? null;
  if (sourceType === 'markdown') {
    if (!file) {
      throw new Error('markdown ファイルを選択してください');
    }
    return { sourceType, markdownFile: { name: file.name, text: () => file.text() } };
  }
  if (!file) {
    throw new Error('.docx ファイルを選択してください');
  }
  return {
    sourceType,
    docxFile: { name: file.name, arrayBuffer: () => file.arrayBuffer() },
  };
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
  wrap.className = 'protocol__source-types';
  const labels: Record<'manual' | 'markdown' | 'docx', string> = {
    manual: '手入力',
    markdown: 'Markdown (.md)',
    docx: 'Word (.docx)',
  };
  for (const value of ['manual', 'markdown', 'docx'] as const) {
    const label = doc.createElement('label');
    label.className = 'protocol__source-option';
    const input = doc.createElement('input');
    input.type = 'radio';
    input.name = 'sourceType';
    input.value = value;
    if (value === 'manual') {
      input.checked = true;
    }
    label.appendChild(input);
    label.appendChild(doc.createTextNode(` ${labels[value]}`));
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
  if (id === 'inline') {
    control.rows = 14;
    control.placeholder =
      'RQ・対象集団・介入/曝露・アウトカム・組入/除外基準などを含むプロトコルを貼り付けてください';
  }
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
