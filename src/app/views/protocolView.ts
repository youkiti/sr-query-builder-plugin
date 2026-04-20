import type { ProtocolSubmissionInput } from '@/app/services';
import { ROUTE_LABELS } from '../router';
import type { RenderView } from './types';

/**
 * プロトコル入力フォーム。
 *
 * 入力モードは 2 系統で排他：
 *   - manual : プロトコル全文の 1 つのテキストエリア
 *   - file   : `.md` / `.markdown` / `.docx` のいずれかをアップロード
 *
 * `ProtocolSubmissionInput.sourceType`（'manual' | 'markdown' | 'docx'）は内部表現として残し、
 * file モード時は拡張子から markdown / docx を判定する。
 *
 * RQ / 組入 / 除外基準は LLM (`extract-protocol` skill) が元テキストから
 * 自動抽出するため、入力フォーム側には持たせない（次の「ブロック承認」画面で編集する）。
 */

export interface ProtocolViewCallbacks {
  onSubmit?: (input: ProtocolSubmissionInput) => void | Promise<void>;
}

type SourceMode = 'manual' | 'file';

const FILE_ACCEPT = '.md,.markdown,.docx';

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
      '最初にレビュー対象のプロトコルを入力します。手入力、または Markdown / Word (.docx) ファイルのアップロードで開始できます。';
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

    const sourceSection = buildSection(doc, '入力形式', buildSourceModeRadios);
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
    const fileSection = buildSection(doc, 'ファイルアップロード', (sectionDoc) => {
      const wrap = sectionDoc.createElement('div');
      wrap.className = 'protocol__section';
      const hint = sectionDoc.createElement('p');
      hint.className = 'protocol__hint';
      hint.textContent =
        'Markdown (.md / .markdown) または Word (.docx) ファイルを選択してください。形式は拡張子で自動判定します。';
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
      const mode = readSourceMode(form);
      manualSection.hidden = mode !== 'manual';
      fileSection.hidden = mode !== 'file';
      submit.textContent =
        mode === 'manual'
          ? 'プロトコル本文を解析してブロック抽出へ'
          : 'ファイルを解析してブロック抽出へ';
    };

    const sourceInputs = form.querySelectorAll<HTMLInputElement>('input[name=sourceMode]');
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
  const mode = readSourceMode(form);
  if (mode === 'manual') {
    const inline = readField(form, 'inline');
    if (!inline.trim()) {
      throw new Error('プロトコル全文を入力してください');
    }
    return { sourceType: 'manual', inlineText: inline };
  }
  const fileInput = form.querySelector<HTMLInputElement>('input[type=file]');
  const file = fileInput?.files?.[0] ?? null;
  if (!file) {
    throw new Error('プロトコルファイルを選択してください');
  }
  const detected = inferSourceTypeFromName(file.name);
  if (detected === 'markdown') {
    return {
      sourceType: 'markdown',
      markdownFile: { name: file.name, text: () => file.text() },
    };
  }
  if (detected === 'docx') {
    return {
      sourceType: 'docx',
      docxFile: { name: file.name, arrayBuffer: () => file.arrayBuffer() },
    };
  }
  throw new Error('対応形式は .md / .markdown / .docx です');
}

function readSourceMode(form: HTMLFormElement): SourceMode {
  const checked = form.querySelector<HTMLInputElement>('input[name=sourceMode]:checked');
  return checked?.value === 'file' ? 'file' : 'manual';
}

/** 拡張子から内部 sourceType を推定。未知の拡張子は null。大文字拡張子も許容。 */
function inferSourceTypeFromName(name: string): 'markdown' | 'docx' | null {
  const lower = name.toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
  if (lower.endsWith('.docx')) return 'docx';
  return null;
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

function buildSourceModeRadios(doc: Document): HTMLElement {
  const wrap = doc.createElement('div');
  wrap.className = 'protocol__source-types';
  const labels: Record<SourceMode, string> = {
    manual: '手入力',
    file: 'ファイルアップロード (.md / .docx)',
  };
  for (const value of ['manual', 'file'] as const) {
    const label = doc.createElement('label');
    label.className = 'protocol__source-option';
    const input = doc.createElement('input');
    input.type = 'radio';
    input.name = 'sourceMode';
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
  input.accept = FILE_ACCEPT;
  wrap.appendChild(input);
  return wrap;
}
