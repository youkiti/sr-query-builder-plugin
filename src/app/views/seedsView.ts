import type { IngestInput, IngestSummary, SeedPaperWithRow } from '@/app/services';
import type { SeedPaper } from '@/domain/seedPaper';
import type { EfetchArticle } from '@/lib/ncbi';
import { ROUTE_LABELS } from '../router';
import type { RenderView } from './types';

/**
 * シード論文入力画面（#/seeds）。
 *
 * - PMID 直接入力（改行・カンマ区切り）
 * - ファイルアップロード（NBIB / RIS を内容で自動判別）
 *
 * 送信後は ingest サマリ（登録 N 件 / 有効 K 件 / 無効 M 件 + 理由別内訳）と、
 * PubMed で存在確認できた文献の詳細書誌情報（title / abstract / MeSH / PubMed リンクなど）
 * を画面内に展開する。実ロジック（onIngest）は bootstrap 側で seedService に繋ぐ。
 */

export interface SeedsViewCallbacks {
  onIngest?: (input: IngestInput) => Promise<IngestSummary>;
  /** 登録済み SeedPapers を行番号付きで一覧する（§4.3 一覧表示） */
  onListSeeds?: () => Promise<SeedPaperWithRow[]>;
  /** 有効行の論理削除（user_removed へ書き換え。§4.3） */
  onInvalidate?: (rowIndex: number, seed: SeedPaper) => Promise<SeedPaper>;
  /** pmid_not_found 行の再試行（1 PMID で再 ingest。§4.3） */
  onRetry?: (pmid: string) => Promise<IngestSummary>;
  /** ris_no_pmid 行への手動 PMID 補完（§4.3）。成功時は新規 pmid_direct 行を追記する */
  onFillPmid?: (rowIndex: number, pmid: string) => Promise<IngestSummary>;
}

export function createSeedsView(callbacks: SeedsViewCallbacks = {}): RenderView {
  return (container, ctx) => {
    container.innerHTML = '';
    const doc = container.ownerDocument;
    const heading = doc.createElement('h2');
    heading.textContent = ROUTE_LABELS.seeds;
    container.appendChild(heading);

    if (!ctx.state.project) {
      const warn = doc.createElement('p');
      warn.className = 'view__placeholder';
      warn.textContent = '先にプロジェクトを選択してください。';
      container.appendChild(warn);
      return;
    }

    const status = doc.createElement('p');
    status.className = 'seeds__status';
    status.setAttribute('aria-live', 'polite');
    container.appendChild(status);

    const errorBox = doc.createElement('p');
    errorBox.className = 'seeds__error';
    errorBox.setAttribute('aria-live', 'polite');
    container.appendChild(errorBox);

    const summaryBox = doc.createElement('div');
    summaryBox.className = 'seeds__summary';
    container.appendChild(summaryBox);

    const detailsBox = doc.createElement('div');
    detailsBox.className = 'seeds__details';
    container.appendChild(detailsBox);

    const form = doc.createElement('div');
    form.className = 'seeds__form';
    container.appendChild(form);

    form.appendChild(
      buildPmidForm(doc, async (pmids) => run({ mode: 'pmid_direct', pmids }))
    );
    form.appendChild(
      buildFileForm(doc, async (file) => run(await detectFileMode(file)))
    );

    // 登録済みシード一覧（§4.3 ingest サマリ UI）。
    const listSection = doc.createElement('section');
    listSection.className = 'seeds__list-section';
    container.appendChild(listSection);
    const listState = { showInvalid: false };

    async function refreshList(): Promise<void> {
      if (!callbacks.onListSeeds) {
        return;
      }
      try {
        const rows = await callbacks.onListSeeds();
        renderSeedList(doc, listSection, rows, listState, {
          onToggleShowInvalid: (next) => {
            listState.showInvalid = next;
            void refreshList();
          },
          onInvalidate: async (rowIndex, seed) => {
            if (!callbacks.onInvalidate) return;
            errorBox.textContent = '';
            try {
              await callbacks.onInvalidate(rowIndex, seed);
              await refreshList();
            } catch (err) {
              errorBox.textContent = formatError(err);
            }
          },
          onRetry: async (pmid) => {
            if (!callbacks.onRetry) return;
            errorBox.textContent = '';
            try {
              await callbacks.onRetry(pmid);
              await refreshList();
            } catch (err) {
              errorBox.textContent = formatError(err);
            }
          },
          onFillPmid: async (rowIndex, pmid) => {
            if (!callbacks.onFillPmid) return;
            errorBox.textContent = '';
            try {
              await callbacks.onFillPmid(rowIndex, pmid);
              await refreshList();
            } catch (err) {
              errorBox.textContent = formatError(err);
            }
          },
        });
      } catch (err) {
        errorBox.textContent = formatError(err);
      }
    }

    void refreshList();

    async function run(input: IngestInput): Promise<void> {
      if (!callbacks.onIngest) {
        return;
      }
      status.textContent = 'ingest 中…';
      errorBox.textContent = '';
      try {
        const result = await callbacks.onIngest(input);
        status.textContent = `${result.registered} 件登録（有効 ${result.valid} / 無効 ${result.invalid}）`;
        renderSummary(doc, summaryBox, result);
        renderDetails(doc, detailsBox, result);
        // ingest 後は一覧も最新化する
        await refreshList();
      } catch (err) {
        errorBox.textContent = formatError(err);
        status.textContent = '';
      }
    }
  };
}

interface SeedListActions {
  onToggleShowInvalid: (next: boolean) => void;
  onInvalidate: (rowIndex: number, seed: SeedPaper) => void | Promise<void>;
  onRetry: (pmid: string) => void | Promise<void>;
  onFillPmid: (rowIndex: number, pmid: string) => void | Promise<void>;
}

/**
 * 登録済みシード一覧を描画する（§4.3）。
 * - デフォルトは is_valid=true のみ表示。「無効行も表示」トグルで全件表示
 * - 有効行: 「無効化」ボタン（論理削除）
 * - pmid_not_found 行: 「再試行」ボタン
 * - 無効行には exclusion_reason を表示する
 *
 * TODO(§4.3): ris_no_pmid 行への「PMID を入力する」補完 UI は今回スコープ外。
 *   タイトルと元 DB から手動補完し、成功時は新規 pmid_direct 行として追記する仕様を別途実装する。
 */
function renderSeedList(
  doc: Document,
  container: HTMLElement,
  rows: SeedPaperWithRow[],
  state: { showInvalid: boolean },
  actions: SeedListActions
): void {
  container.innerHTML = '';

  const heading = doc.createElement('h3');
  heading.className = 'seeds__list-title';
  heading.textContent = '登録済みシード一覧';
  container.appendChild(heading);

  const validCount = rows.filter((r) => r.seed.isValid).length;
  const invalidCount = rows.length - validCount;

  const toggleLabel = doc.createElement('label');
  toggleLabel.className = 'seeds__list-toggle';
  const toggle = doc.createElement('input');
  toggle.type = 'checkbox';
  toggle.className = 'seeds__show-invalid';
  toggle.checked = state.showInvalid;
  toggle.addEventListener('change', () => actions.onToggleShowInvalid(toggle.checked));
  toggleLabel.appendChild(toggle);
  toggleLabel.appendChild(
    doc.createTextNode(` 無効行も表示（無効 ${invalidCount} 件）`)
  );
  container.appendChild(toggleLabel);

  const visible = state.showInvalid ? rows : rows.filter((r) => r.seed.isValid);

  if (rows.length === 0) {
    const empty = doc.createElement('p');
    empty.className = 'seeds__list-empty';
    empty.textContent = 'まだシードが登録されていません。';
    container.appendChild(empty);
    return;
  }

  if (visible.length === 0) {
    const empty = doc.createElement('p');
    empty.className = 'seeds__list-empty';
    empty.textContent = `有効なシードはありません（無効 ${invalidCount} 件は「無効行も表示」で確認できます）。`;
    container.appendChild(empty);
    return;
  }

  const list = doc.createElement('ul');
  list.className = 'seeds__list';
  for (const row of visible) {
    list.appendChild(buildSeedRow(doc, row, actions));
  }
  container.appendChild(list);
}

function buildSeedRow(
  doc: Document,
  row: SeedPaperWithRow,
  actions: SeedListActions
): HTMLElement {
  const { seed, rowIndex } = row;
  const li = doc.createElement('li');
  li.className = `seeds__list-item seeds__list-item--${seed.isValid ? 'valid' : 'invalid'}`;
  li.dataset['rowIndex'] = String(rowIndex);

  const label = doc.createElement('span');
  label.className = 'seeds__list-label';
  const idText = seed.pmid ? `PMID ${seed.pmid}` : `(PMID 無し) ${seed.title ?? ''}`;
  label.textContent = seed.isValid
    ? `✅ ${idText}`
    : `⚠️ ${idText} — ${seed.exclusionReason ?? '無効'}`;
  li.appendChild(label);

  const controls = doc.createElement('span');
  controls.className = 'seeds__list-controls';

  if (seed.isValid) {
    const invalidateBtn = doc.createElement('button');
    invalidateBtn.type = 'button';
    invalidateBtn.className = 'seeds__list-invalidate';
    invalidateBtn.textContent = '無効化';
    invalidateBtn.addEventListener('click', () => {
      invalidateBtn.disabled = true;
      void Promise.resolve(actions.onInvalidate(rowIndex, seed)).finally(() => {
        invalidateBtn.disabled = false;
      });
    });
    controls.appendChild(invalidateBtn);
  } else if (seed.exclusionReason === 'pmid_not_found' && seed.pmid) {
    const retryBtn = doc.createElement('button');
    retryBtn.type = 'button';
    retryBtn.className = 'seeds__list-retry';
    retryBtn.textContent = '再試行';
    const pmid = seed.pmid;
    retryBtn.addEventListener('click', () => {
      retryBtn.disabled = true;
      void Promise.resolve(actions.onRetry(pmid)).finally(() => {
        retryBtn.disabled = false;
      });
    });
    controls.appendChild(retryBtn);
  } else if (seed.exclusionReason === 'no_pmid_resolved') {
    // ris_no_pmid 行: 「PMIDを入力する」ボタン → インライン入力 → 補完
    const fillBtn = doc.createElement('button');
    fillBtn.type = 'button';
    fillBtn.className = 'seeds__list-fill-pmid';
    fillBtn.textContent = 'PMIDを入力する';

    const inputEl = doc.createElement('input');
    inputEl.type = 'text';
    inputEl.className = 'seeds__fill-pmid-input';
    inputEl.placeholder = 'PMID';
    inputEl.hidden = true;
    inputEl.setAttribute('aria-label', 'PMID 入力');

    const confirmBtn = doc.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'seeds__fill-pmid-confirm';
    confirmBtn.textContent = '確定';
    confirmBtn.hidden = true;

    const cancelBtn = doc.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'seeds__fill-pmid-cancel';
    cancelBtn.textContent = 'キャンセル';
    cancelBtn.hidden = true;

    fillBtn.addEventListener('click', () => {
      fillBtn.hidden = true;
      inputEl.hidden = false;
      confirmBtn.hidden = false;
      cancelBtn.hidden = false;
      inputEl.focus();
    });

    cancelBtn.addEventListener('click', () => {
      fillBtn.hidden = false;
      inputEl.hidden = true;
      confirmBtn.hidden = true;
      cancelBtn.hidden = true;
      inputEl.value = '';
    });

    const doFill = (): void => {
      const val = inputEl.value.trim();
      if (!val) return;
      confirmBtn.disabled = true;
      cancelBtn.disabled = true;
      void Promise.resolve(actions.onFillPmid(rowIndex, val)).finally(() => {
        confirmBtn.disabled = false;
        cancelBtn.disabled = false;
      });
    };

    confirmBtn.addEventListener('click', doFill);
    inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        doFill();
      }
    });

    controls.appendChild(fillBtn);
    controls.appendChild(inputEl);
    controls.appendChild(confirmBtn);
    controls.appendChild(cancelBtn);
  }

  li.appendChild(controls);
  return li;
}

function renderSummary(doc: Document, container: HTMLElement, summary: IngestSummary): void {
  container.innerHTML = '';
  if (summary.registered === 0) {
    return;
  }
  const reasons = summary.reasons;
  const parts: string[] = [];
  if (reasons.pmid_not_found > 0) parts.push(`PMID 不在: ${reasons.pmid_not_found}`);
  if (reasons.duplicate_pmid > 0) parts.push(`重複: ${reasons.duplicate_pmid}`);
  if (reasons.no_pmid_resolved > 0) parts.push(`PMID 解決不能: ${reasons.no_pmid_resolved}`);
  if (reasons.other > 0) parts.push(`その他: ${reasons.other}`);
  if (parts.length > 0) {
    const detail = doc.createElement('p');
    detail.className = 'seeds__reasons';
    detail.textContent = `内訳: ${parts.join(' / ')}`;
    container.appendChild(detail);
  }

  if (summary.added.length > 0) {
    const ul = doc.createElement('ul');
    ul.className = 'seeds__added';
    for (const seed of summary.added) {
      const li = doc.createElement('li');
      const label = seed.pmid ? `PMID ${seed.pmid}` : `(PMID 無し) ${seed.title ?? ''}`;
      const status = seed.isValid ? '✅ 有効' : `⚠️ ${seed.exclusionReason ?? '無効'}`;
      li.textContent = `${label} — ${status}`;
      ul.appendChild(li);
    }
    container.appendChild(ul);
  }
}

function renderDetails(doc: Document, container: HTMLElement, summary: IngestSummary): void {
  container.innerHTML = '';
  const validSeeds = summary.added.filter((s) => s.isValid && s.pmid);
  if (validSeeds.length === 0) {
    return;
  }
  const heading = doc.createElement('h3');
  heading.className = 'seeds__details-title';
  heading.textContent = `登録された文献 (${validSeeds.length} 件)`;
  container.appendChild(heading);

  const list = doc.createElement('ol');
  list.className = 'seeds__details-list';
  for (const seed of validSeeds) {
    const pmid = seed.pmid as string;
    const article = summary.articles[pmid] ?? null;
    list.appendChild(buildArticleCard(doc, pmid, seed.title ?? null, seed.year ?? null, article));
  }
  container.appendChild(list);
}

function buildArticleCard(
  doc: Document,
  pmid: string,
  fallbackTitle: string | null,
  fallbackYear: number | null,
  article: EfetchArticle | null
): HTMLElement {
  const li = doc.createElement('li');
  li.className = 'seeds__article';

  const header = doc.createElement('div');
  header.className = 'seeds__article-header';

  const title = doc.createElement('h4');
  title.className = 'seeds__article-title';
  title.textContent = article?.title ?? fallbackTitle ?? `(タイトル不明) PMID ${pmid}`;
  header.appendChild(title);

  const link = doc.createElement('a');
  link.className = 'seeds__article-link';
  link.href = `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = `PubMed PMID ${pmid} ↗`;
  header.appendChild(link);

  li.appendChild(header);

  const meta = buildMetaLine(doc, fallbackYear, article);
  if (meta) {
    li.appendChild(meta);
  }

  if (article?.authors && article.authors.length > 0) {
    const authors = doc.createElement('p');
    authors.className = 'seeds__article-authors';
    authors.textContent = formatAuthors(article.authors);
    li.appendChild(authors);
  }

  if (article?.doi) {
    const doi = doc.createElement('p');
    doi.className = 'seeds__article-doi';
    const a = doc.createElement('a');
    a.href = `https://doi.org/${article.doi}`;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = `doi:${article.doi}`;
    doi.appendChild(doc.createTextNode('DOI: '));
    doi.appendChild(a);
    li.appendChild(doi);
  }

  if (article?.abstract) {
    const wrap = doc.createElement('div');
    wrap.className = 'seeds__article-abstract';
    const label = doc.createElement('div');
    label.className = 'seeds__article-section-label';
    label.textContent = 'Abstract';
    wrap.appendChild(label);
    const body = doc.createElement('p');
    body.className = 'seeds__article-abstract-body';
    body.textContent = article.abstract;
    wrap.appendChild(body);
    li.appendChild(wrap);
  }

  if (article?.meshHeadings && article.meshHeadings.length > 0) {
    const wrap = doc.createElement('div');
    wrap.className = 'seeds__article-mesh';
    const label = doc.createElement('div');
    label.className = 'seeds__article-section-label';
    label.textContent = 'MeSH';
    wrap.appendChild(label);
    const ul = doc.createElement('ul');
    ul.className = 'seeds__article-mesh-list';
    for (const mh of article.meshHeadings) {
      const item = doc.createElement('li');
      item.className = 'seeds__article-mesh-item';
      item.textContent = mh;
      ul.appendChild(item);
    }
    wrap.appendChild(ul);
    li.appendChild(wrap);
  }

  return li;
}

function buildMetaLine(
  doc: Document,
  fallbackYear: number | null,
  article: EfetchArticle | null
): HTMLElement | null {
  const parts: string[] = [];
  if (article?.journal) {
    parts.push(article.journal);
  }
  const year = article?.year ?? fallbackYear;
  if (year !== null && year !== undefined) {
    parts.push(String(year));
  }
  const volIssue = formatVolumeIssue(article);
  if (volIssue) {
    parts.push(volIssue);
  }
  if (article?.pages) {
    parts.push(article.pages);
  }
  if (parts.length === 0) {
    return null;
  }
  const p = doc.createElement('p');
  p.className = 'seeds__article-meta';
  p.textContent = parts.join(' · ');
  return p;
}

function formatVolumeIssue(article: EfetchArticle | null): string | null {
  if (!article) return null;
  if (article.volume && article.issue) {
    return `${article.volume}(${article.issue})`;
  }
  if (article.volume) {
    return article.volume;
  }
  if (article.issue) {
    return `(${article.issue})`;
  }
  return null;
}

function formatAuthors(authors: string[]): string {
  if (authors.length <= 6) {
    return authors.join(', ');
  }
  return `${authors.slice(0, 6).join(', ')}, ほか ${authors.length - 6} 名`;
}

function buildPmidForm(
  doc: Document,
  onSubmit: (pmids: string[]) => Promise<void>
): HTMLElement {
  const fieldset = doc.createElement('fieldset');
  fieldset.className = 'seeds__section';
  const legend = doc.createElement('legend');
  legend.textContent = 'PMID を直接入力';
  fieldset.appendChild(legend);

  const textarea = doc.createElement('textarea');
  textarea.placeholder = 'PMID を改行またはカンマ区切りで貼り付け';
  textarea.className = 'seeds__pmid-input';
  textarea.setAttribute('aria-label', 'PMID 入力');
  fieldset.appendChild(textarea);

  const btn = doc.createElement('button');
  btn.type = 'button';
  btn.className = 'seeds__primary';
  btn.textContent = '登録';
  fieldset.appendChild(btn);

  btn.addEventListener('click', () => {
    const raw = textarea.value;
    const pmids = raw
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter((s) => s !== '');
    btn.disabled = true;
    void onSubmit(pmids).finally(() => {
      btn.disabled = false;
    });
  });

  return fieldset;
}

function buildFileForm(
  doc: Document,
  onSubmit: (file: File) => Promise<void>
): HTMLElement {
  const fieldset = doc.createElement('fieldset');
  fieldset.className = 'seeds__section';
  const legend = doc.createElement('legend');
  legend.textContent = 'ファイルアップロード（NBIB / RIS）';
  fieldset.appendChild(legend);

  const hint = doc.createElement('p');
  hint.className = 'seeds__hint';
  hint.textContent =
    'PubMed の .nbib / 各種データベースの .ris をそのまま選択してください。形式は内容から自動判別します。';
  fieldset.appendChild(hint);

  const fileInput = doc.createElement('input');
  fileInput.type = 'file';
  fileInput.className = 'seeds__file';
  fileInput.accept = '.nbib,.ris,.txt';
  fileInput.setAttribute('aria-label', 'NBIB / RIS ファイル');
  fieldset.appendChild(fileInput);

  const btn = doc.createElement('button');
  btn.type = 'button';
  btn.className = 'seeds__primary';
  btn.textContent = 'アップロードして登録';
  fieldset.appendChild(btn);

  btn.addEventListener('click', () => {
    const file = fileInput.files?.[0];
    if (!file) {
      return;
    }
    btn.disabled = true;
    void onSubmit(file).finally(() => {
      btn.disabled = false;
    });
  });
  return fieldset;
}

/**
 * NBIB と RIS を内容で自動判別する。
 * - RIS: 行頭が `TY  -`（journal, book, etc.）で始まる
 * - NBIB: PubMed Medline 形式で `PMID-` などのタグを持つ
 * 拡張子が明確（.nbib / .ris）であればそれを優先する。
 */
export async function detectFileMode(file: File): Promise<IngestInput> {
  const text = await file.text();
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.ris')) {
    return { mode: 'ris', text };
  }
  if (lower.endsWith('.nbib')) {
    return { mode: 'nbib', text };
  }
  // 拡張子が曖昧（.txt など）なら中身でスニッフ
  if (/^TY\s{0,2}-\s/m.test(text)) {
    return { mode: 'ris', text };
  }
  return { mode: 'nbib', text };
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
