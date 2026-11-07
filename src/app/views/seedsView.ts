import { t } from '@/lib/i18n';
import { ROUTE_LABELS } from '../router';
import type { IngestInput, IngestSummary, SeedPaperWithRow } from '@/app/services';
import type { SeedPaper } from '@/domain/seedPaper';
import type { EfetchArticle } from '@/lib/ncbi';
import type { RenderView } from './types';

const MESH_BROWSER_BASE = 'https://www.ncbi.nlm.nih.gov/mesh/?term=';

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
  /** チェックボックスによる有効/無効の切り替え（user_disabled との往復。§4.3） */
  onSetEnabled?: (rowIndex: number, seed: SeedPaper, enabled: boolean) => Promise<SeedPaper>;
  /** 行の削除（user_removed への論理削除。一覧から消えるが行はシートに残る。§4.3） */
  onDelete?: (rowIndex: number, seed: SeedPaper) => Promise<SeedPaper>;
  /** pmid_not_found 行の再試行（1 PMID で再 ingest。§4.3） */
  onRetry?: (pmid: string) => Promise<IngestSummary>;
  /** ris_no_pmid 行への手動 PMID 補完（§4.3）。成功時は新規 pmid_direct 行を追記する */
  onFillPmid?: (rowIndex: number, pmid: string) => Promise<IngestSummary>;
  /** PMID を指定して NCBI から書誌詳細（タイトル・MeSH 等）を取得する */
  onFetchArticle?: (pmid: string) => Promise<EfetchArticle | null>;
}

export function createSeedsView(callbacks: SeedsViewCallbacks = {}): RenderView {
  const unsavedInputs: SeedInputs = { pmids: '', file: null, inline: new Map() };
  const listState = { showInvalid: false };
  let projectId: string | undefined;
  let refreshCurrentList: (() => Promise<void>) | null = null;
  return (container, ctx) => {
    if (projectId !== ctx.state.project?.projectId) {
      projectId = ctx.state.project?.projectId;
      unsavedInputs.pmids = '';
      unsavedInputs.file = null;
      unsavedInputs.inline.clear();
      listState.showInvalid = false;
    }
    container.innerHTML = '';
    const doc = container.ownerDocument;
    const heading = doc.createElement('h2');
    heading.textContent = ROUTE_LABELS.seeds;
    container.appendChild(heading);

    if (!ctx.state.project) {
      const warn = doc.createElement('p');
      warn.className = 'view__placeholder';
      warn.textContent = t('seeds.noProject');
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
    form.dataset.tour = 'seeds-form';
    container.appendChild(form);

    form.appendChild(
      buildPmidForm(doc, unsavedInputs, async (pmids) => run({ mode: 'pmid_direct', pmids }))
    );
    form.appendChild(
      buildFileForm(doc, unsavedInputs, async (file) => run(await detectFileMode(file)))
    );

    // 登録済みシード一覧（§4.3 ingest サマリ UI）。
    const listSection = doc.createElement('section');
    listSection.className = 'seeds__list-section';
    container.appendChild(listSection);

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
          onSetEnabled: async (rowIndex, seed, enabled) => {
            if (!callbacks.onSetEnabled) return;
            errorBox.textContent = '';
            try {
              await callbacks.onSetEnabled(rowIndex, seed, enabled);
              await refreshList();
            } catch (err) {
              errorBox.textContent = formatError(err);
            }
          },
          onDelete: async (rowIndex, seed) => {
            if (!callbacks.onDelete) return;
            errorBox.textContent = '';
            try {
              await callbacks.onDelete(rowIndex, seed);
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
              if (unsavedInputs.inline.get(rowIndex)?.value.trim() === pmid) {
                unsavedInputs.inline.delete(rowIndex);
              }
              await (refreshCurrentList?.() ?? refreshList());
            } catch (err) {
              errorBox.textContent = formatError(err);
            }
          },
          onFetchArticle: callbacks.onFetchArticle,
        }, unsavedInputs);
      } catch (err) {
        errorBox.textContent = formatError(err);
      }
    }

    refreshCurrentList = refreshList;
    void refreshList();

    async function run(input: IngestInput): Promise<boolean> {
      if (!callbacks.onIngest) {
        return false;
      }
      status.textContent = t('seeds.ingesting');
      errorBox.textContent = '';
      try {
        const result = await callbacks.onIngest(input);
        status.textContent = t('seeds.result', { registered: result.registered, valid: result.valid, invalid: result.invalid });
        renderSummary(doc, summaryBox, result);
        renderDetails(doc, detailsBox, result);
        // ingest 後は一覧も最新化する
        await refreshList();
        return true;
      } catch (err) {
        errorBox.textContent = formatError(err);
        status.textContent = '';
        return false;
      }
    }
  };
}

interface SeedInputs {
  pmids: string;
  file: File | null;
  inline: Map<number, { value: string }>;
  pmidInput?: HTMLTextAreaElement;
  fileInput?: HTMLInputElement;
}

interface SeedListActions {
  onToggleShowInvalid: (next: boolean) => void;
  onSetEnabled: (rowIndex: number, seed: SeedPaper, enabled: boolean) => void | Promise<void>;
  onDelete: (rowIndex: number, seed: SeedPaper) => void | Promise<void>;
  onRetry: (pmid: string) => void | Promise<void>;
  onFillPmid: (rowIndex: number, pmid: string) => void | Promise<void>;
  onFetchArticle?: (pmid: string) => Promise<EfetchArticle | null>;
}

/** 一覧のデフォルト表示に含める行か（有効行 + チェックボックスで無効化中の行）。§4.3 */
function isListedByDefault(seed: SeedPaper): boolean {
  return seed.isValid || seed.exclusionReason === 'user_disabled';
}

/**
 * 登録済みシード一覧を描画する（§4.3）。
 * - デフォルトは有効行 + user_disabled（チェックボックス OFF）行を表示。
 *   取込失敗・削除済み行（pmid_not_found / duplicate_pmid / user_removed / no_pmid_resolved）は
 *   「取込失敗・削除済みの行も表示」トグルで全件表示
 * - 有効行・user_disabled 行: 左端チェックボックスで有効/無効を往復 + 「削除」ボタン（論理削除）
 * - pmid_not_found 行: 「再試行」ボタン
 * - 取込失敗行には exclusion_reason を表示する
 *
 * TODO(§4.3): ris_no_pmid 行への「PMID を入力する」補完 UI は今回スコープ外。
 *   タイトルと元 DB から手動補完し、成功時は新規 pmid_direct 行として追記する仕様を別途実装する。
 */
function renderSeedList(
  doc: Document,
  container: HTMLElement,
  rows: SeedPaperWithRow[],
  state: { showInvalid: boolean },
  actions: SeedListActions,
  unsavedInputs: SeedInputs
): void {
  container.innerHTML = '';

  const heading = doc.createElement('h3');
  heading.className = 'seeds__list-title';
  heading.textContent = t('seeds.list');
  container.appendChild(heading);

  const hiddenCount = rows.filter((r) => !isListedByDefault(r.seed)).length;

  const toggleLabel = doc.createElement('label');
  toggleLabel.className = 'seeds__list-toggle';
  const toggle = doc.createElement('input');
  toggle.type = 'checkbox';
  toggle.className = 'seeds__show-invalid';
  toggle.checked = state.showInvalid;
  toggle.addEventListener('change', () => actions.onToggleShowInvalid(toggle.checked));
  toggleLabel.appendChild(toggle);
  toggleLabel.appendChild(
    doc.createTextNode(t('seeds.showInvalid', { count: hiddenCount }))
  );
  container.appendChild(toggleLabel);

  const visible = state.showInvalid ? rows : rows.filter((r) => isListedByDefault(r.seed));

  if (rows.length === 0) {
    const empty = doc.createElement('p');
    empty.className = 'seeds__list-empty';
    empty.textContent = t('seeds.empty');
    container.appendChild(empty);
    return;
  }

  if (visible.length === 0) {
    const empty = doc.createElement('p');
    empty.className = 'seeds__list-empty';
    empty.textContent = t('seeds.noVisible', { count: hiddenCount });
    container.appendChild(empty);
    return;
  }

  const list = doc.createElement('ul');
  list.className = 'seeds__list';
  for (const row of visible) {
    list.appendChild(buildSeedRow(doc, row, actions, unsavedInputs));
  }
  container.appendChild(list);
}

function buildSeedRow(
  doc: Document,
  row: SeedPaperWithRow,
  actions: SeedListActions,
  unsavedInputs: SeedInputs
): HTMLElement {
  const { seed, rowIndex } = row;
  // user_disabled はチェックボックスで往復できる「一時無効」。取込失敗系の invalid と区別する
  const isDisabledRow = !seed.isValid && seed.exclusionReason === 'user_disabled';
  const modifier = seed.isValid ? 'valid' : isDisabledRow ? 'disabled' : 'invalid';
  const li = doc.createElement('li');
  li.className = `seeds__list-item seeds__list-item--${modifier}`;
  li.dataset['rowIndex'] = String(rowIndex);

  // --- 上段: 有効/無効チェックボックス + ステータスバッジ + タイトル + コントロール ---
  const header = doc.createElement('div');
  header.className = 'seeds__list-header';
  li.appendChild(header);

  const idText = seed.pmid ? `PMID ${seed.pmid}` : t('seeds.noPmid', { title: seed.title ?? '' });

  if (seed.isValid || isDisabledRow) {
    const enabledBox = doc.createElement('input');
    enabledBox.type = 'checkbox';
    enabledBox.className = 'seeds__list-enabled';
    enabledBox.checked = seed.isValid;
    enabledBox.setAttribute('aria-label', t('seeds.enable', { id: idText }));
    enabledBox.addEventListener('change', () => {
      enabledBox.disabled = true;
      void Promise.resolve(actions.onSetEnabled(rowIndex, seed, enabledBox.checked)).finally(
        () => {
          enabledBox.disabled = false;
        }
      );
    });
    header.appendChild(enabledBox);
  }

  const label = doc.createElement('span');
  label.className = 'seeds__list-label';
  if (seed.isValid || isDisabledRow) {
    // 有効/無効はチェックボックスの ON/OFF とグレーアウトで表現する（バッジは付けない）
    label.textContent = idText;
  } else {
    label.textContent = `⚠️ ${idText} — ${seed.exclusionReason ?? t('seeds.invalid')}`;
  }
  header.appendChild(label);

  if (seed.title) {
    const titleEl = doc.createElement('span');
    titleEl.className = 'seeds__list-item-title';
    titleEl.textContent = seed.title;
    header.appendChild(titleEl);
  }

  // --- 展開パネル（クリックで詳細を表示） ---
  const detailPanel = doc.createElement('div');
  detailPanel.className = 'seeds__list-detail';
  detailPanel.hidden = true;
  let detailLoaded = false;

  if (seed.pmid && actions.onFetchArticle) {
    const expandBtn = doc.createElement('button');
    expandBtn.type = 'button';
    expandBtn.className = 'seeds__list-expand';
    expandBtn.textContent = t('seeds.detailsClosed');
    header.appendChild(expandBtn);

    const fetchArticle = actions.onFetchArticle;
    const pmid = seed.pmid;
    expandBtn.addEventListener('click', () => {
      if (detailPanel.hidden) {
        detailPanel.hidden = false;
        expandBtn.textContent = t('seeds.detailsOpen');
        if (!detailLoaded) {
          detailLoaded = true;
          detailPanel.textContent = t('seeds.loading');
          fetchArticle(pmid)
            .then((article) => {
              detailPanel.innerHTML = '';
              detailPanel.appendChild(
                buildArticleCardContent(doc, pmid, seed.title, seed.year, article)
              );
            })
            .catch((err: unknown) => {
              detailPanel.textContent = t('seeds.fetchFailed', { error: formatError(err) });
            });
        }
      } else {
        detailPanel.hidden = true;
        expandBtn.textContent = t('seeds.detailsClosed');
      }
    });
  }

  const controls = doc.createElement('span');
  controls.className = 'seeds__list-controls';

  if (seed.isValid || isDisabledRow) {
    const deleteBtn = doc.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'seeds__list-delete';
    deleteBtn.textContent = t('seeds.delete');
    deleteBtn.addEventListener('click', () => {
      deleteBtn.disabled = true;
      void Promise.resolve(actions.onDelete(rowIndex, seed)).finally(() => {
        deleteBtn.disabled = false;
      });
    });
    controls.appendChild(deleteBtn);
  } else if (seed.exclusionReason === 'pmid_not_found' && seed.pmid) {
    const retryBtn = doc.createElement('button');
    retryBtn.type = 'button';
    retryBtn.className = 'seeds__list-retry';
    retryBtn.textContent = t('seeds.retry');
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
    fillBtn.textContent = t('seeds.fillPmid');

    const inputEl = doc.createElement('input');
    inputEl.type = 'text';
    inputEl.className = 'seeds__fill-pmid-input';
    inputEl.placeholder = 'PMID';
    inputEl.hidden = true;
    inputEl.setAttribute('aria-label', t('seeds.pmidAria'));

    const confirmBtn = doc.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'seeds__fill-pmid-confirm';
    confirmBtn.textContent = t('seeds.confirm');
    confirmBtn.hidden = true;

    const cancelBtn = doc.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'seeds__fill-pmid-cancel';
    cancelBtn.textContent = t('seeds.cancel');
    cancelBtn.hidden = true;

    if (unsavedInputs.inline.has(rowIndex)) {
      fillBtn.hidden = true;
      inputEl.hidden = false;
      inputEl.value = unsavedInputs.inline.get(rowIndex)!.value;
      confirmBtn.hidden = false;
      cancelBtn.hidden = false;
    }
    inputEl.addEventListener('input', () => {
      unsavedInputs.inline.set(rowIndex, { value: inputEl.value });
    });
    fillBtn.addEventListener('click', () => {
      unsavedInputs.inline.set(rowIndex, { value: inputEl.value });
      fillBtn.hidden = true;
      inputEl.hidden = false;
      confirmBtn.hidden = false;
      cancelBtn.hidden = false;
      inputEl.focus();
    });

    cancelBtn.addEventListener('click', () => {
      unsavedInputs.inline.delete(rowIndex);
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

  header.appendChild(controls);
  li.appendChild(detailPanel);
  return li;
}

function renderSummary(doc: Document, container: HTMLElement, summary: IngestSummary): void {
  container.innerHTML = '';
  if (summary.registered === 0) {
    return;
  }
  const reasons = summary.reasons;
  const parts: string[] = [];
  if (reasons.pmid_not_found > 0) parts.push(t('seeds.notFound', { count: reasons.pmid_not_found }));
  if (reasons.duplicate_pmid > 0) parts.push(t('seeds.duplicate', { count: reasons.duplicate_pmid }));
  if (reasons.no_pmid_resolved > 0) parts.push(t('seeds.unresolved', { count: reasons.no_pmid_resolved }));
  if (reasons.other > 0) parts.push(t('seeds.other', { count: reasons.other }));
  if (parts.length > 0) {
    const detail = doc.createElement('p');
    detail.className = 'seeds__reasons';
    detail.textContent = t('seeds.breakdown', { parts: parts.join(' / ') });
    container.appendChild(detail);
  }

  if (summary.added.length > 0) {
    const ul = doc.createElement('ul');
    ul.className = 'seeds__added';
    for (const seed of summary.added) {
      const li = doc.createElement('li');
      const label = seed.pmid ? `PMID ${seed.pmid}` : t('seeds.noPmid', { title: seed.title ?? '' });
      const status = seed.isValid ? t('seeds.valid') : `⚠️ ${seed.exclusionReason ?? t('seeds.invalid')}`;
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
  heading.textContent = t('seeds.registeredArticles', { count: validSeeds.length });
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

function buildArticleCardContent(
  doc: Document,
  pmid: string,
  fallbackTitle: string | null,
  fallbackYear: number | null,
  article: EfetchArticle | null
): HTMLElement {
  const wrap = doc.createElement('div');
  wrap.className = 'seeds__article-content';

  const articleHeader = doc.createElement('div');
  articleHeader.className = 'seeds__article-header';

  const title = doc.createElement('h4');
  title.className = 'seeds__article-title';
  title.textContent = article?.title ?? fallbackTitle ?? t('seeds.unknownTitle', { pmid });
  articleHeader.appendChild(title);

  const link = doc.createElement('a');
  link.className = 'seeds__article-link';
  link.href = `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = `PubMed PMID ${pmid} ↗`;
  articleHeader.appendChild(link);

  wrap.appendChild(articleHeader);

  const meta = buildMetaLine(doc, fallbackYear, article);
  if (meta) {
    wrap.appendChild(meta);
  }

  if (article?.authors && article.authors.length > 0) {
    const authors = doc.createElement('p');
    authors.className = 'seeds__article-authors';
    authors.textContent = formatAuthors(article.authors);
    wrap.appendChild(authors);
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
    wrap.appendChild(doi);
  }

  if (article?.abstract) {
    const abstractWrap = doc.createElement('div');
    abstractWrap.className = 'seeds__article-abstract';
    const label = doc.createElement('div');
    label.className = 'seeds__article-section-label';
    label.textContent = 'Abstract';
    abstractWrap.appendChild(label);
    const body = doc.createElement('p');
    body.className = 'seeds__article-abstract-body';
    body.textContent = article.abstract;
    abstractWrap.appendChild(body);
    wrap.appendChild(abstractWrap);
  }

  if (article?.meshHeadings && article.meshHeadings.length > 0) {
    const meshWrap = doc.createElement('div');
    meshWrap.className = 'seeds__article-mesh';
    const label = doc.createElement('div');
    label.className = 'seeds__article-section-label';
    label.textContent = 'MeSH';
    meshWrap.appendChild(label);
    const ul = doc.createElement('ul');
    ul.className = 'seeds__article-mesh-list';
    for (const mh of article.meshHeadings) {
      const item = doc.createElement('li');
      item.className = 'seeds__article-mesh-item';
      const a = doc.createElement('a');
      a.href = `${MESH_BROWSER_BASE}${encodeURIComponent(mh)}`;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.className = 'seeds__article-mesh-link';
      a.textContent = mh;
      item.appendChild(a);
      ul.appendChild(item);
    }
    meshWrap.appendChild(ul);
    wrap.appendChild(meshWrap);
  }

  return wrap;
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
  li.appendChild(buildArticleCardContent(doc, pmid, fallbackTitle, fallbackYear, article));
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
  return t('seeds.moreAuthors', { authors: authors.slice(0, 6).join(', '), count: authors.length - 6 });
}

function buildPmidForm(
  doc: Document,
  unsavedInputs: SeedInputs,
  onSubmit: (pmids: string[]) => Promise<boolean>
): HTMLElement {
  const fieldset = doc.createElement('fieldset');
  fieldset.className = 'seeds__section';
  const legend = doc.createElement('legend');
  legend.textContent = t('seeds.directPmid');
  fieldset.appendChild(legend);

  const textarea = doc.createElement('textarea');
  textarea.placeholder = t('seeds.pmidPlaceholder');
  textarea.className = 'seeds__pmid-input';
  textarea.setAttribute('aria-label', t('seeds.pmidAria'));
  textarea.value = unsavedInputs.pmids;
  unsavedInputs.pmidInput = textarea;
  textarea.addEventListener('input', () => { unsavedInputs.pmids = textarea.value; });
  fieldset.appendChild(textarea);

  const btn = doc.createElement('button');
  btn.type = 'button';
  btn.className = 'seeds__primary';
  btn.textContent = t('seeds.register');
  fieldset.appendChild(btn);

  btn.addEventListener('click', () => {
    const raw = textarea.value;
    const pmids = raw
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter((s) => s !== '');
    btn.disabled = true;
    void onSubmit(pmids).then((success) => {
      if (success && unsavedInputs.pmids === raw) {
        unsavedInputs.pmids = '';
        textarea.value = '';
        if (unsavedInputs.pmidInput) unsavedInputs.pmidInput.value = '';
      }
    }).finally(() => {
      btn.disabled = false;
    });
  });

  return fieldset;
}

function buildFileForm(
  doc: Document,
  unsavedInputs: SeedInputs,
  onSubmit: (file: File) => Promise<boolean>
): HTMLElement {
  const fieldset = doc.createElement('fieldset');
  fieldset.className = 'seeds__section';
  const legend = doc.createElement('legend');
  legend.textContent = t('seeds.fileUpload');
  fieldset.appendChild(legend);

  const hint = doc.createElement('p');
  hint.className = 'seeds__hint';
  hint.textContent =
    t('seeds.fileHint');
  fieldset.appendChild(hint);

  const fileInput = doc.createElement('input');
  fileInput.type = 'file';
  fileInput.className = 'seeds__file';
  fileInput.accept = '.nbib,.ris,.txt';
  fileInput.setAttribute('aria-label', t('seeds.fileAria'));
  unsavedInputs.fileInput = fileInput;
  if (unsavedInputs.file && typeof DataTransfer !== 'undefined') {
    const dt = new DataTransfer();
    dt.items.add(unsavedInputs.file);
    fileInput.files = dt.files;
  }
  fileInput.addEventListener('change', () => { unsavedInputs.file = fileInput.files?.[0] ?? null; });
  fieldset.appendChild(fileInput);

  const btn = doc.createElement('button');
  btn.type = 'button';
  btn.className = 'seeds__primary';
  btn.textContent = t('seeds.uploadRegister');
  fieldset.appendChild(btn);

  btn.addEventListener('click', () => {
    const file = fileInput.files?.[0] ?? unsavedInputs.file;
    if (!file) {
      return;
    }
    btn.disabled = true;
    void onSubmit(file).then((success) => {
      if (success && unsavedInputs.file === file) {
        unsavedInputs.file = null;
        fileInput.value = '';
        if (unsavedInputs.fileInput) unsavedInputs.fileInput.value = '';
      }
    }).finally(() => {
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
