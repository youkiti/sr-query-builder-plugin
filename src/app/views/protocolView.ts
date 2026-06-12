import type { ProtocolSubmissionInput } from '@/app/services';
import type { Protocol } from '@/domain/protocol';
import type { ProtocolDraft } from '../store';
import { ROUTE_LABELS } from '../router';
import type { RenderView } from './types';

/**
 * プロトコル入力・閲覧・改訂画面（requirements.md §4.2「プロトコル画面の再訪・改訂フロー」）。
 *
 * 表示は 3 モード：
 *   1. 新規入力フォーム      : protocolDraft が無い
 *   2. 下書き復元フォーム    : protocolDraft はあるが未承認（protocolDraftPersisted=false）
 *   3. 読み取り専用 + 編集   : 承認済み（protocolDraftPersisted=true）。
 *      バージョン切替で過去版も閲覧でき、「編集する」で改訂フォームに入る。
 *      改訂保存時は「検索ブロックを作り直すか」を確認パネルで尋ねる。
 *
 * 入力モードは 2 系統で排他：
 *   - manual : プロトコル全文の 1 つのテキストエリア
 *   - file   : `.md` / `.markdown` / `.docx` のいずれかをアップロード
 *
 * RQ / 組入 / 除外基準は LLM (`extract-protocol` skill) が元テキストから
 * 自動抽出するため、入力フォーム側には持たせない（次の「ブロック承認」画面で編集する）。
 */

export interface ProtocolViewCallbacks {
  /** 解析（extract-protocol）してブロック承認画面へ。初回入力と「ブロックを作り直す」改訂の両方が使う */
  onSubmit?: (input: ProtocolSubmissionInput) => void | Promise<void>;
  /**
   * 既存ブロックを維持したまま改訂を保存する。
   * 新しい Protocol.version を即時追記し、既存ブロックを同 version へコピーする（§4.2）。
   */
  onReviseKeepBlocks?: (input: ProtocolSubmissionInput) => void | Promise<void>;
  /** Protocol タブの全バージョンを version 降順で返す（バージョン切替 UI 用） */
  onListVersions?: () => Promise<Protocol[]>;
}

type SourceMode = 'manual' | 'file';

const FILE_ACCEPT = '.md,.markdown,.docx';

/** 読み取り専用表示用に ProtocolDraft / Protocol を正規化したもの */
interface ProtocolDisplay {
  version: number | null;
  isLatest: boolean;
  frameworkType: string;
  researchQuestion: string;
  inclusionCriteria: string;
  exclusionCriteria: string;
  studyDesign: string;
  sourceType: 'manual' | 'markdown' | 'docx';
  sourceFilename: string | null;
  rawTextInline: string | null;
  rawTextPreview: string;
  createdAt: string | null;
  createdBy: string | null;
}

interface FormRenderOptions {
  /** 手入力テキストエリアの初期値 */
  prefillText: string;
  /** 承認済みプロトコルの改訂として開いたか。true なら保存時に確認パネルを出す */
  revising: boolean;
  /**
   * 「未保存の下書き」ステータスバッジを出すか。
   * 承認前 draft の復元時のみ true（保存済みの読み取り専用表示と一目で区別するため）。
   */
  unsavedBadge: boolean;
  /** フォーム上部の案内文。不要なら null */
  notice: string | null;
  /** 改訂時のみ: 読み取り専用表示へ戻る。null ならキャンセルボタンを出さない */
  onCancel: (() => void) | null;
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

    // モード切替（読み取り専用 ↔ 編集）で描き替える領域
    const body = doc.createElement('div');
    body.className = 'protocol__body';
    container.appendChild(body);

    // onListVersions の結果キャッシュ（この描画サイクル内のみ有効）
    let versions: Protocol[] | null = null;

    const canKeepBlocks =
      callbacks.onReviseKeepBlocks !== undefined &&
      (ctx.state.blocksDraft?.blocks.length ?? 0) >= 1;

    const showForm = (opts: FormRenderOptions): void => {
      body.innerHTML = '';

      if (opts.unsavedBadge) {
        const badge = doc.createElement('div');
        badge.className = 'protocol__draft-status';
        badge.setAttribute('role', 'status');
        const title = doc.createElement('strong');
        title.className = 'protocol__draft-status-title';
        title.textContent = '⚠ 未保存の下書き';
        badge.appendChild(title);
        const desc = doc.createElement('span');
        desc.className = 'protocol__draft-status-desc';
        desc.textContent =
          'このプロトコルはまだスプレッドシートに保存されていません。「ブロック承認」まで進むと確定保存されます。';
        badge.appendChild(desc);
        body.appendChild(badge);
      }

      if (opts.notice !== null) {
        const notice = doc.createElement('p');
        notice.className = 'protocol__notice';
        notice.textContent = opts.notice;
        body.appendChild(notice);
      }

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
        wrap.appendChild(buildField(sectionDoc, 'inline', 'プロトコル全文', opts.prefillText));
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

      const actions = doc.createElement('div');
      actions.className = 'protocol__actions';
      const submit = doc.createElement('button');
      submit.type = 'submit';
      submit.className = 'protocol__submit';
      actions.appendChild(submit);
      if (opts.onCancel !== null) {
        const cancel = doc.createElement('button');
        cancel.type = 'button';
        cancel.className = 'protocol__cancel';
        cancel.textContent = '編集をやめる';
        cancel.addEventListener('click', () => opts.onCancel?.());
        actions.appendChild(cancel);
      }
      form.appendChild(actions);

      const progress = buildProgress(doc);
      form.appendChild(progress.element);

      const errorBox = doc.createElement('p');
      errorBox.className = 'protocol__error';
      errorBox.id = 'protocol-error';
      errorBox.setAttribute('aria-live', 'polite');
      form.appendChild(errorBox);

      // 改訂時のみ: 「検索ブロックを作り直しますか？」確認パネル（§4.2）
      const confirmPanel = doc.createElement('div');
      confirmPanel.className = 'protocol__revise-confirm';
      confirmPanel.setAttribute('role', 'group');
      confirmPanel.setAttribute('aria-label', '検索ブロックの扱いを選択');
      confirmPanel.hidden = true;
      if (opts.revising) {
        const question = doc.createElement('p');
        question.className = 'protocol__revise-question';
        question.textContent =
          '検索ブロックを作り直しますか？ どちらを選んでもプロトコルは新しいバージョンとして追記され、元のバージョンは保持されます。';
        confirmPanel.appendChild(question);
        form.appendChild(confirmPanel);
      }

      const runSubmission = (
        handler: ((input: ProtocolSubmissionInput) => void | Promise<void>) | undefined
      ): void => {
        try {
          const input = collectFormInput(form);
          submit.disabled = true;
          progress.start();
          void Promise.resolve(handler?.(input))
            .catch((err: unknown) => {
              errorBox.textContent = formatError(err);
            })
            .finally(() => {
              submit.disabled = false;
              progress.stop();
            });
        } catch (err) {
          errorBox.textContent = formatError(err);
        }
      };

      if (opts.revising) {
        const rebuild = doc.createElement('button');
        rebuild.type = 'button';
        rebuild.className = 'protocol__revise-rebuild';
        rebuild.textContent = 'AI でブロックを再抽出して作り直す';
        rebuild.addEventListener('click', () => {
          confirmPanel.hidden = true;
          runSubmission(callbacks.onSubmit);
        });
        confirmPanel.appendChild(rebuild);

        if (canKeepBlocks) {
          const keep = doc.createElement('button');
          keep.type = 'button';
          keep.className = 'protocol__revise-keep';
          keep.textContent = '既存の検索ブロックを維持して保存';
          keep.addEventListener('click', () => {
            confirmPanel.hidden = true;
            runSubmission(callbacks.onReviseKeepBlocks);
          });
          confirmPanel.appendChild(keep);
        }

        const cancelConfirm = doc.createElement('button');
        cancelConfirm.type = 'button';
        cancelConfirm.className = 'protocol__revise-cancel';
        cancelConfirm.textContent = 'キャンセル';
        cancelConfirm.addEventListener('click', () => {
          confirmPanel.hidden = true;
          submit.disabled = false;
        });
        confirmPanel.appendChild(cancelConfirm);
      }

      const syncMode = (): void => {
        const mode = readSourceMode(form);
        manualSection.hidden = mode !== 'manual';
        fileSection.hidden = mode !== 'file';
        if (opts.revising) {
          submit.textContent = '新しいバージョンとして保存';
        } else {
          submit.textContent =
            mode === 'manual'
              ? 'プロトコル本文を解析してブロック抽出へ'
              : 'ファイルを解析してブロック抽出へ';
        }
      };

      const sourceInputs = form.querySelectorAll<HTMLInputElement>('input[name=sourceMode]');
      sourceInputs.forEach((input) => input.addEventListener('change', syncMode));
      syncMode();

      form.addEventListener('submit', (event) => {
        event.preventDefault();
        errorBox.textContent = '';
        if (!opts.revising) {
          runSubmission(callbacks.onSubmit);
          return;
        }
        // 改訂時はまず入力を検証してから確認パネルを出す
        try {
          collectFormInput(form);
        } catch (err) {
          errorBox.textContent = formatError(err);
          return;
        }
        confirmPanel.hidden = false;
        submit.disabled = true;
      });

      body.appendChild(form);
    };

    const showReadOnly = (display: ProtocolDisplay): void => {
      body.innerHTML = '';
      const wrap = doc.createElement('div');
      wrap.className = 'protocol__readonly';

      const versionLabel = doc.createElement('p');
      versionLabel.className = 'protocol__version-label';
      versionLabel.textContent = `確定済みプロトコル v${display.version ?? '—'}${
        display.isLatest ? '（最新）' : '（過去バージョン）'
      }`;
      wrap.appendChild(versionLabel);

      const errorBox = doc.createElement('p');
      errorBox.className = 'protocol__error';
      errorBox.id = 'protocol-error';
      errorBox.setAttribute('aria-live', 'polite');

      if (callbacks.onListVersions) {
        wrap.appendChild(buildVersionSwitcher(display, errorBox));
      }

      wrap.appendChild(buildSummary(doc, display));

      if (!display.isLatest) {
        const note = doc.createElement('p');
        note.className = 'protocol__old-note';
        note.textContent =
          '過去バージョンを表示中です。このバージョンをベースに編集して保存すると、最新の次のバージョンとして追記されます。';
        wrap.appendChild(note);
      }

      const edit = doc.createElement('button');
      edit.type = 'button';
      edit.className = 'protocol__edit';
      edit.textContent = display.isLatest
        ? 'このプロトコルを編集する'
        : 'このバージョンをベースに編集する';
      edit.addEventListener('click', () => {
        showForm({
          prefillText: display.rawTextInline ?? '',
          revising: true,
          unsavedBadge: false,
          notice: buildEditNotice(display),
          onCancel: () => showReadOnly(display),
        });
      });
      wrap.appendChild(edit);

      wrap.appendChild(errorBox);
      body.appendChild(wrap);
    };

    /** バージョン切替 UI。未取得なら読込ボタン、取得済みなら select を出す */
    const buildVersionSwitcher = (
      display: ProtocolDisplay,
      errorBox: HTMLElement
    ): HTMLElement => {
      const area = doc.createElement('div');
      area.className = 'protocol__versions';
      if (versions === null) {
        const load = doc.createElement('button');
        load.type = 'button';
        load.className = 'protocol__load-versions';
        load.textContent = '過去のバージョンを表示';
        load.addEventListener('click', () => {
          load.disabled = true;
          void Promise.resolve(callbacks.onListVersions?.())
            .then((list) => {
              versions = list ?? [];
              showReadOnly(display);
            })
            .catch((err: unknown) => {
              load.disabled = false;
              errorBox.textContent = formatError(err);
            });
        });
        area.appendChild(load);
        return area;
      }
      if (versions.length === 0) {
        const empty = doc.createElement('p');
        empty.className = 'protocol__versions-empty';
        empty.textContent = '保存済みバージョンがまだありません。';
        area.appendChild(empty);
        return area;
      }
      const latestVersion = versions[0]?.version ?? null;
      const label = doc.createElement('label');
      label.className = 'protocol__version-select';
      const span = doc.createElement('span');
      span.textContent = '表示するバージョン';
      label.appendChild(span);
      const select = doc.createElement('select');
      select.id = 'protocol-version-select';
      for (const p of versions) {
        const option = doc.createElement('option');
        option.value = String(p.version);
        option.textContent = `v${p.version}（${p.createdAt}）`;
        if (p.version === display.version) {
          option.selected = true;
        }
        select.appendChild(option);
      }
      select.addEventListener('change', () => {
        const picked = versions?.find((p) => String(p.version) === select.value);
        /* istanbul ignore if -- option は versions からのみ生成されるので必ず見つかる */
        if (!picked) {
          return;
        }
        showReadOnly(displayFromProtocol(picked, latestVersion));
      });
      label.appendChild(select);
      area.appendChild(label);
      return area;
    };

    const draft = ctx.state.protocolDraft;
    if (draft !== null && ctx.state.protocolDraftPersisted) {
      showReadOnly(displayFromDraft(draft, ctx.state.currentProtocolVersion));
    } else {
      showForm({
        prefillText: draft?.rawTextInline ?? '',
        revising: false,
        // 承認前 draft は「未保存」バッジで保存済み画面と明確に区別する
        unsavedBadge: draft !== null,
        notice:
          draft !== null
            ? '本文を確認・修正して再解析するか、「ブロック承認」画面で続きを進めてください。'
            : null,
        onCancel: null,
      });
    }
  };
}

/**
 * 旧 API（callback 無し）。テストや placeholder 用途で残す。
 * 実際の wiring は createProtocolView を使う。
 */
export const renderProtocolView: RenderView = createProtocolView();

function displayFromDraft(draft: ProtocolDraft, version: number | null): ProtocolDisplay {
  return {
    version,
    isLatest: true,
    frameworkType: draft.frameworkType,
    researchQuestion: draft.researchQuestion,
    inclusionCriteria: draft.inclusionCriteria,
    exclusionCriteria: draft.exclusionCriteria,
    studyDesign: draft.studyDesign,
    sourceType: draft.sourceType,
    sourceFilename: draft.sourceFilename,
    rawTextInline: draft.rawTextInline,
    rawTextPreview: draft.rawTextPreview,
    createdAt: null,
    createdBy: null,
  };
}

function displayFromProtocol(protocol: Protocol, latestVersion: number | null): ProtocolDisplay {
  return {
    version: protocol.version,
    isLatest: latestVersion !== null && protocol.version === latestVersion,
    frameworkType: protocol.frameworkType ?? 'custom',
    researchQuestion: protocol.researchQuestion,
    inclusionCriteria: protocol.inclusionCriteria ?? '',
    exclusionCriteria: protocol.exclusionCriteria ?? '',
    studyDesign: protocol.studyDesign ?? '',
    sourceType: protocol.sourceType,
    sourceFilename: protocol.sourceFilename,
    rawTextInline: protocol.rawTextInline,
    rawTextPreview: protocol.rawTextPreview ?? '',
    createdAt: protocol.createdAt,
    createdBy: protocol.createdBy,
  };
}

function buildEditNotice(display: ProtocolDisplay): string {
  const base = `v${display.version ?? '—'} を編集中。保存すると新しいバージョンとして追記され、元のバージョンは保持されます。`;
  if (display.rawTextInline === null) {
    return `${base} 元の本文（ファイル入力）は手元に無いため、本文を再入力または再アップロードしてください。`;
  }
  return base;
}

const SOURCE_TYPE_LABELS: Record<ProtocolDisplay['sourceType'], string> = {
  manual: '手入力',
  markdown: 'Markdown ファイル',
  docx: 'Word (.docx) ファイル',
};

function buildSummary(doc: Document, display: ProtocolDisplay): HTMLElement {
  const dl = doc.createElement('dl');
  dl.className = 'protocol__summary';
  const rows: [string, string][] = [
    ['フレームワーク', display.frameworkType],
    ['リサーチクエスチョン', display.researchQuestion],
    ['組入基準', display.inclusionCriteria],
    ['除外基準', display.exclusionCriteria],
    ['研究デザイン', display.studyDesign],
    [
      '入力形式',
      display.sourceFilename === null
        ? SOURCE_TYPE_LABELS[display.sourceType]
        : `${SOURCE_TYPE_LABELS[display.sourceType]}（${display.sourceFilename}）`,
    ],
    ['本文', display.rawTextInline ?? display.rawTextPreview],
    ['作成日時', display.createdAt ?? ''],
    ['作成者', display.createdBy ?? ''],
  ];
  for (const [term, value] of rows) {
    const dt = doc.createElement('dt');
    dt.textContent = term;
    const dd = doc.createElement('dd');
    dd.textContent = value === '' ? '—' : value;
    dl.appendChild(dt);
    dl.appendChild(dd);
  }
  return dl;
}

function collectFormInput(form: HTMLFormElement): ProtocolSubmissionInput {
  const mode = readSourceMode(form);
  if (mode === 'manual') {
    // 手入力かつ空文字の場合もエラーにしない（§4.2）。
    // extract-protocol skill が空ドラフト（空ブロック 1 行 / combination '#1'）を返し、
    // ユーザーは #/blocks でゼロからブロックを編集できる。
    const inline = readField(form, 'inline');
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

function buildField(doc: Document, id: string, label: string, initialValue = ''): HTMLElement {
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
  control.value = initialValue;
  wrap.appendChild(control);
  return wrap;
}

interface ProgressHandle {
  element: HTMLElement;
  start: () => void;
  stop: () => void;
}

/**
 * 送信中に「AI が動いている」ことを伝える進捗インジケータ。
 *
 * プロトコル解析は LLM 呼び出しを含み 10〜30 秒かかり得るので、
 * 経過秒数と段階ラベルを表示し、沈黙時間を埋める。
 *
 * 段階ラベルは実処理の厳密なフェーズではなく、経過時間に応じた
 * ヒューリスティック。ユーザーに「止まっていない」感を与えるのが目的。
 */
function buildProgress(doc: Document): ProgressHandle {
  const element = doc.createElement('div');
  element.className = 'protocol__progress';
  element.id = 'protocol-progress';
  element.setAttribute('role', 'status');
  element.setAttribute('aria-live', 'polite');
  element.hidden = true;

  const spinner = doc.createElement('span');
  spinner.className = 'protocol__spinner';
  spinner.setAttribute('aria-hidden', 'true');
  element.appendChild(spinner);

  const stage = doc.createElement('span');
  stage.className = 'protocol__progress-stage';
  element.appendChild(stage);

  const elapsed = doc.createElement('span');
  elapsed.className = 'protocol__progress-elapsed';
  elapsed.setAttribute('aria-hidden', 'true');
  element.appendChild(elapsed);

  let timerId: ReturnType<typeof setInterval> | null = null;
  let startedAt = 0;

  const update = (): void => {
    const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    stage.textContent = stageLabel(seconds);
    elapsed.textContent = `${seconds}s`;
  };

  return {
    element,
    start: () => {
      startedAt = Date.now();
      element.hidden = false;
      update();
      if (timerId !== null) {
        clearInterval(timerId);
      }
      timerId = setInterval(update, 1000);
    },
    stop: () => {
      if (timerId !== null) {
        clearInterval(timerId);
        timerId = null;
      }
      element.hidden = true;
    },
  };
}

function stageLabel(seconds: number): string {
  if (seconds < 3) return 'AI がプロトコルを読み取り中…';
  if (seconds < 15) return 'AI がブロック候補を抽出中…';
  return 'まだ処理中です。LLM の応答を待っています…';
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
