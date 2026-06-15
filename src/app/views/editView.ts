import {
  applyBlockImprovement,
  type BlockImprovementContext,
  type BlockImprovementResult,
  type CombinationCheckResult,
  type RequestBlockImprovementInput,
  type SaveEditedFormulaInput,
  type SaveEditedFormulaResult,
} from '@/app/services';
import { parsePubmedFormulaMd } from '@/lib/search-formula-md';
import type { MeshTreeEntry } from '@/features/validation';
import type { MeshTreeNode } from '@/lib/ncbi';
import { ROUTE_LABELS } from '../router';
import type { BlocksDraft } from '../store';
import { buildBlockInspector, type SiblingBlock } from './blockInspector';
import {
  buildLegend,
  diffExpressions,
  renderDiffSideInto,
  renderExpressionInto,
} from './formulaDisplay';
import { dedupeOperands, sortOperandsMeshFirst } from './meshExpressionEdit';
import type { RenderView } from './types';

/**
 * 検索式手編集画面（#/edit）。
 *
 * ブロック（`#1`〜）ごとのカードを並べ、各ブロックに対して 2 つの編集手段を提供する:
 *
 * 1. **インライン手編集**: カードにホバー / フォーカスすると鉛筆ボタンが現れ、
 *    クリックでその行を直接書き換えられる。保存すると内部の formula_md を更新する。
 * 2. **ブロック単位 AI 改善（requirements.md §4.7）**: 「AI に改善させる」を押すと
 *    任意の指示文を入力する欄が開き（空でも可）、improve-block skill を実行する。
 *    提案 expression と rationale を diff 表示し、「置き換える」で内部 md に反映する。
 *
 * 検索式 Markdown 全文は内部状態 `currentMd` として保持し（テキストエリアは出さない）、
 * 「新バージョンとして保存」で FormulaVersions に user_edit として追記する。
 *
 * サービス呼び出しは bootstrap 側で editService の各関数を callback として渡す。
 */

export interface EditViewCallbacks {
  /** 「新バージョンとして保存」: 履歴を残したいときだけ押す。新しい version を追記する */
  onSave?: (input: SaveEditedFormulaInput) => Promise<SaveEditedFormulaResult>;
  /**
   * 動的保存（上書き）。ブロックを編集／AI 改善を反映するたびに呼ばれ、現在の作業
   * バージョン行を同じ場所に上書きする（履歴は増やさない）。fire-and-forget で呼び、
   * 実行・多重制御・状態反映は呼び出し側（bootstrap）が store.editAutoSave 経由で行う。
   */
  onAutoSave?: (formulaMd: string) => void;
  /** 指定ブロックを LLM で改善させる（instruction はユーザー任意の指示） */
  onImproveBlock?: (input: RequestBlockImprovementInput) => Promise<BlockImprovementResult>;
  /** 「AI に渡す内容を見る」表示用の文脈スナップショットを取得する（SeedPapers 読み取りを伴う） */
  onGetImproveContext?: (blockId: string) => Promise<BlockImprovementContext | null>;
  /**
   * ブロック式単体のヒット数を計測する（esearch count）。注入された場合のみ、各概念ブロックの
   * 件数をライブ表示する。結合行（`#1 AND #2`）は #N 参照を含み単体検索できないので対象外。
   */
  onCountHits?: (expression: string) => Promise<number>;
  /**
   * MeSH descriptor 群の tree number を取得する（db=mesh）。注入された場合のみ、ブロック編集／
   * AI 改善パネルを開いたときにブロック・インスペクタの MeSH ツリーを描画する。
   */
  onFetchMeshTrees?: (descriptors: string[]) => Promise<MeshTreeEntry[]>;
  /**
   * tree number → 子ノード（1 段下・名前付き）を取得する（MeSH RDF）。注入された場合のみ、
   * インスペクタの MeSH ブラウザで下位語ナビ（クリックで下りる・件数のライブ表示）を出す。
   */
  onFetchMeshChildren?: (treeNumber: string) => Promise<MeshTreeNode[]>;
  /**
   * tree number 群 → ノード（descriptor + 名前）をバッチ逆引きする（MeSH RDF）。注入された場合のみ、
   * MeSH ツリーの祖先ノードに ID だけでなく名前を表示する。
   */
  onFetchMeshLabels?: (treeNumbers: string[]) => Promise<Map<string, MeshTreeNode>>;
  /**
   * 結合行（最終検索式）を実際に検索し、同時に有効シード論文の捕捉状況を確認する。
   * 注入された場合のみ、結合行に「検索してシード捕捉を確認」ボタンを出す。
   * 引数は編集中の md 全文（保存前でも確認できるよう view が保持している現在値）。
   */
  onCheckCombination?: (formulaMd: string) => Promise<CombinationCheckResult>;
}

/**
 * ブロック描画に必要な周辺情報。
 * - blocksDraft: `#N` が何の概念ブロックかを示すラベル解決に使う
 * - hitsCache: 同じ式を再計測しないための式→件数キャッシュ（view インスタンスで共有）
 */
interface BlockRenderContext {
  blocksDraft: BlocksDraft | null;
  hitsCache: Map<string, Promise<number>>;
  /** 結合行チェックの md→結果キャッシュ（同一 md の重複 esearch を防ぐ） */
  comboCache: Map<string, Promise<CombinationCheckResult>>;
  /** インスペクタ MeSH ツリーの descriptor 群→tree entries キャッシュ */
  meshTreeCache: Map<string, Promise<MeshTreeEntry[]>>;
  /** MeSH ブラウザの tree number→子ノード キャッシュ */
  meshChildrenCache: Map<string, Promise<MeshTreeNode[]>>;
  /** MeSH ブラウザの tree number 群→ラベル Map キャッシュ */
  meshLabelCache: Map<string, Promise<Map<string, MeshTreeNode>>>;
  /** MeSH ブラウザの展開状態（blockId→展開済み tree number 集合）。再描画をまたいで保持 */
  meshExpandedState: Map<string, Set<string>>;
  /**
   * ブロックごとの AI 改善パネル状態（pending / proposal / error）。
   * 全ビュー再描画（store.setState）をまたいで提案を失わないよう view インスタンスで持ち越し、
   * buildBlockRow が毎回ここから AI スロットを再構築する。
   */
  aiPanels: Map<string, AiPanelState>;
  /**
   * 統合編集パネル（手編集 + AI 改善）が開いているブロック ID の集合。鉛筆トグルで開閉し、
   * 全ビュー再描画をまたいで開閉状態を保持して、再描画後も buildBlockRow がパネルを復元する。
   */
  openEditPanels: Set<string>;
  /**
   * 指定ブロックの AI 提案サブ領域だけを、最新の DOM 上で aiPanels の状態から作り直す。
   * AI 改善の非同期コールバック（LLM の then 等）は、自分が作られた時点ではなく「最新の」
   * ライブ DOM へ反映する必要があるため、これを経由する。全体は再描画しないので、
   * 行要素は維持され、進行中の手編集なども巻き込まない。
   */
  refreshPanel: (blockId: string) => void;
}

/** ブロック単位 AI 改善パネルの状態（再描画をまたいで保持する）。 */
type AiPanelState =
  | { kind: 'pending' }
  | { kind: 'proposal'; result: BlockImprovementResult; baseFormulaMd: string }
  | { kind: 'error'; message: string };

/**
 * 概念ブロック `#N`（数値 ID・非結合行）に対応する blocksDraft 上のラベルを返す。
 * 結合行・フィルタ行（非数値 ID）・blocksDraft 外の ID では null。
 */
function blockLabelFor(
  blocksDraft: BlocksDraft | null,
  blockId: string,
  isCombination: boolean
): string | null {
  if (isCombination || blocksDraft === null) {
    return null;
  }
  const n = Number.parseInt(blockId, 10);
  if (!Number.isFinite(n) || n < 1) {
    return null;
  }
  const label = blocksDraft.blocks[n - 1]?.blockLabel?.trim();
  return label ? label : null;
}

/** 式→件数のキャッシュ越しに onCountHits を呼ぶ（同一式の重複 esearch を防ぐ）。 */
function countHitsCached(
  onCountHits: NonNullable<EditViewCallbacks['onCountHits']>,
  cache: Map<string, Promise<number>>,
  expression: string
): Promise<number> {
  const cached = cache.get(expression);
  if (cached) {
    return cached;
  }
  const pending = onCountHits(expression);
  cache.set(expression, pending);
  return pending;
}

/** 検索式 Markdown 全文を保持し、更新時にブロック一覧を再描画する内部コントローラ。 */
interface FormulaEditor {
  getMd(): string;
  /** md を差し替えてブロック一覧を再描画する */
  setMd(next: string): void;
}

export function createEditView(callbacks: EditViewCallbacks = {}): RenderView {
  // ヒット数キャッシュは view インスタンスの生存期間で持ち越す（式→件数は安定なので、
  // 自動保存などで全体が再描画されても同じ式は再 esearch しない）。
  const hitsCache = new Map<string, Promise<number>>();
  // 結合行チェックの結果も view インスタンスで持ち越す（同一 md なら自動再実行でも再 esearch しない）。
  const comboCache = new Map<string, Promise<CombinationCheckResult>>();
  // インスペクタの MeSH ツリー取得結果も view インスタンスで持ち越す。
  const meshTreeCache = new Map<string, Promise<MeshTreeEntry[]>>();
  // MeSH ブラウザの子ノード / ラベル逆引きも view インスタンスで持ち越す。
  const meshChildrenCache = new Map<string, Promise<MeshTreeNode[]>>();
  const meshLabelCache = new Map<string, Promise<Map<string, MeshTreeNode>>>();
  // MeSH ブラウザの展開状態も view インスタンスで持ち越す（置換/追加の再描画をまたぐ）。
  const meshExpandedState = new Map<string, Set<string>>();
  // store.setState による全ビュー再描画をまたいで保持する「作業中の md」。
  // store.currentFormulaMarkdown とは別に作業コピーを closure で持つことで、自動保存中（saving）の
  // stale な setState 再描画や、LLM コスト集計の setState 再描画でも、確定前の編集を失わない。
  let workingMd: string | null = null;
  // 直近に store から取り込んだ md（reconcile 用）。これと store の値がズレたら store 側を採用する。
  let syncedStoreMd: string | null = null;
  // ブロックごとの AI 改善パネル状態。再描画後も buildBlockRow がここから再構築する。
  const aiPanels = new Map<string, AiPanelState>();
  // 鉛筆で開いている統合編集パネル（手編集 + AI）のブロック ID。再描画をまたいで開閉を保持する。
  const openEditPanels = new Set<string>();
  // 最新の「指定ブロックの AI 提案サブ領域の再構築」への間接参照。AI 改善の非同期 then 等が
  // 「最新の」ライブ DOM へ反映できるようにする（全体再描画はしない）。
  let latestRefreshPanel: (blockId: string) => void = () => {};
  const refreshPanel = (blockId: string): void => latestRefreshPanel(blockId);
  return (container, ctx) => {
    container.innerHTML = '';
    const doc = container.ownerDocument;
    const heading = doc.createElement('h2');
    heading.textContent = ROUTE_LABELS.edit;
    container.appendChild(heading);

    if (!ctx.state.project) {
      const warn = doc.createElement('p');
      warn.className = 'view__placeholder';
      warn.textContent = '先にプロジェクトを選択してください。';
      container.appendChild(warn);
      return;
    }
    if (!ctx.state.currentFormulaMarkdown) {
      const warn = doc.createElement('p');
      warn.className = 'view__placeholder';
      warn.textContent = '先に /draft で検索式を生成するか、/history で読み込んでください。';
      container.appendChild(warn);
      return;
    }

    // store の md と作業コピーを突き合わせる。store 側が変わっていれば（新規生成・履歴復元・
    // 自動保存の確定）それを採用し、変わっていなければ作業コピー（未確定の編集）を保つ。
    // これにより、自動保存中（saving）の stale な setState 再描画でも編集が OLD に戻らない。
    const storeMd = ctx.state.currentFormulaMarkdown;
    if (workingMd === null || storeMd !== syncedStoreMd) {
      if (storeMd !== workingMd) {
        // 検索式そのものが差し替わった（履歴復元など）ので、進行中の AI 改善パネルは破棄する。
        aiPanels.clear();
      }
      workingMd = storeMd;
      syncedStoreMd = storeMd;
    }

    const lead = doc.createElement('p');
    lead.className = 'edit__lead';
    lead.textContent = callbacks.onAutoSave
      ? '各ブロックは鉛筆アイコンで直接編集するか、「AI に改善させる」で再設計できます。編集は自動でシートに上書き保存され、結合行のヒット数とシード捕捉も自動で再確認されます。あとで戻れる区切りを残したいときだけ、上の「この状態を履歴に残す」を押してください。'
      : '各ブロックは鉛筆アイコンで直接編集するか、「AI に改善させる」で再設計できます。「この状態を履歴に残す」を押すと FormulaVersions に user_edit として追記されます。';
    container.appendChild(lead);

    // 動的保存（上書き）の状態行。実際の保存実行・多重制御は bootstrap が担い、
    // 状態は store.editAutoSave に入る（保存完了の setState による再描画でも表示が残るよう、
    // draftRun などと同じく store 経由で描画する）。
    if (ctx.state.editAutoSave) {
      const autoSaveStatus = doc.createElement('p');
      autoSaveStatus.className = `edit__autosave edit__autosave--${ctx.state.editAutoSave.status}`;
      autoSaveStatus.setAttribute('aria-live', 'polite');
      autoSaveStatus.textContent = ctx.state.editAutoSave.message;
      container.appendChild(autoSaveStatus);
    }

    // 内部状態。テキストエリアは表示せず、closure の workingMd を単一の真実とする。
    const editor: FormulaEditor = {
      getMd: () => workingMd ?? '',
      setMd: (next: string) => {
        workingMd = next;
        rerenderBlocks();
        // ブロック編集 / AI 改善の反映が確定するたびに上書き保存する（fire-and-forget。
        // 実行・多重制御・状態反映は bootstrap 側が store.editAutoSave 経由で行う）。
        callbacks.onAutoSave?.(next);
      },
    };

    // 「この状態を履歴に残す」（=スナップショット / 旧「新バージョンとして保存」）を上部に置く。
    // 通常の編集は自動上書き保存されるので、これは「あとで戻れる区切り」を明示的に残すための操作。
    // 「フォーク」という語は使わず、何が起きるかを文言と補足説明で伝える。
    const historyBar = doc.createElement('section');
    historyBar.className = 'edit__history-bar';

    const actions = doc.createElement('div');
    actions.className = 'edit__actions';
    const saveBtn = doc.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'edit__save-snapshot';
    saveBtn.textContent = '📌 この状態を履歴に残す';
    saveBtn.title =
      'あとで戻れる区切りとして、いまの検索式を履歴のスナップショットに保存します（ふだんの編集は自動で上書き保存されています）。';
    actions.appendChild(saveBtn);
    historyBar.appendChild(actions);

    const historyHelp = doc.createElement('p');
    historyHelp.className = 'edit__history-help';
    historyHelp.textContent = callbacks.onAutoSave
      ? 'あとで戻れる区切りとして履歴に保存します。ふだんの編集は自動で保存されているので、ここぞという区切りのときだけ押せば十分です。保存した時点には「バージョン履歴」からいつでも戻れます。'
      : 'いまの検索式を履歴に 1 件保存します（FormulaVersions に user_edit として追記）。保存した時点には「バージョン履歴」から戻れます。';
    historyBar.appendChild(historyHelp);

    const noteRow = doc.createElement('p');
    noteRow.className = 'edit__note-row';
    const noteLabel = doc.createElement('label');
    noteLabel.textContent = '編集メモ:';
    const noteInput = doc.createElement('input');
    noteInput.type = 'text';
    noteInput.className = 'edit__note-input';
    noteInput.placeholder = '変更理由・気づきなど（任意）';
    noteLabel.appendChild(noteInput);
    noteRow.appendChild(noteLabel);
    historyBar.appendChild(noteRow);

    const status = doc.createElement('p');
    status.className = 'edit__status';
    status.setAttribute('aria-live', 'polite');
    historyBar.appendChild(status);

    const errorBox = doc.createElement('p');
    errorBox.className = 'edit__error';
    errorBox.setAttribute('aria-live', 'polite');
    historyBar.appendChild(errorBox);

    container.appendChild(historyBar);

    const blocksSection = doc.createElement('section');
    blocksSection.className = 'edit__blocks';
    const blocksHeading = doc.createElement('h3');
    blocksHeading.textContent = 'ブロック';
    blocksSection.appendChild(blocksHeading);
    // draft 画面と同じ MeSH / フリーワードの色分け凡例
    blocksSection.appendChild(buildLegend(doc));
    const blocksList = doc.createElement('ul');
    blocksList.className = 'edit__block-list';
    blocksSection.appendChild(blocksList);
    container.appendChild(blocksSection);

    // ラベル解決元の blocksDraft と、view インスタンス共通のヒット数キャッシュ。
    const renderCtx: BlockRenderContext = {
      blocksDraft: ctx.state.blocksDraft,
      hitsCache,
      comboCache,
      meshTreeCache,
      meshChildrenCache,
      meshLabelCache,
      meshExpandedState,
      aiPanels,
      openEditPanels,
      refreshPanel,
    };

    function rerenderBlocks(): void {
      renderBlockList(doc, blocksList, editor, callbacks, renderCtx);
    }
    // 非同期コールバックが「最新の」ライブ DOM 上の AI 提案サブ領域へ反映できるよう、
    // 毎回ここで間接参照を差し替える。指定ブロックの提案サブ領域だけを aiPanels から作り直す。
    latestRefreshPanel = (blockId: string): void => {
      const row = blocksList.querySelector(`.edit__block-row[data-block-id="${blockId}"]`);
      const proposalSlot = row?.querySelector('.edit__block-ai-proposal');
      if (!(proposalSlot instanceof HTMLElement)) {
        return;
      }
      const panel = aiPanels.get(blockId);
      if (panel) {
        materializeAiPanel(doc, proposalSlot, panel, blockId, editor, renderCtx);
      } else {
        proposalSlot.innerHTML = '';
      }
    };
    rerenderBlocks();

    saveBtn.addEventListener('click', () => {
      if (!callbacks.onSave) {
        return;
      }
      saveBtn.disabled = true;
      status.textContent = '保存中…';
      errorBox.textContent = '';
      callbacks
        .onSave({ formulaMd: editor.getMd(), note: noteInput.value })
        .then((result) => {
          status.textContent = `保存しました（version_id: ${result.versionId}）`;
        })
        .catch((err: unknown) => {
          errorBox.textContent = formatError(err);
          status.textContent = '';
        })
        .finally(() => {
          saveBtn.disabled = false;
        });
    });
  };
}

/**
 * editor.getMd() を parsePubmedFormulaMd でブロック分解し、各ブロックのカードを再描画する。
 * パースに失敗した場合はその旨を表示する。
 */
function renderBlockList(
  doc: Document,
  ul: HTMLElement,
  editor: FormulaEditor,
  callbacks: EditViewCallbacks,
  renderCtx: BlockRenderContext
): void {
  ul.innerHTML = '';
  let formula;
  try {
    formula = parsePubmedFormulaMd(editor.getMd());
  } catch (err) {
    const warn = doc.createElement('li');
    warn.className = 'edit__block-error';
    warn.textContent = `現状の検索式が PubMed セクション形式としてパースできません: ${formatError(err)}`;
    ul.appendChild(warn);
    return;
  }
  if (formula.blocks.length === 0) {
    const empty = doc.createElement('li');
    empty.className = 'edit__block-empty';
    empty.textContent = 'ブロックがありません。';
    ul.appendChild(empty);
    return;
  }
  for (const block of formula.blocks) {
    ul.appendChild(
      buildBlockRow(
        doc,
        block.id,
        block.expression,
        block.isCombination,
        editor,
        callbacks,
        renderCtx,
        formula.blocks
      )
    );
  }
}

/**
 * 当該ブロック以外の概念ブロック（結合行を除く）を、インスペクタの重複判定用に整形する。
 */
function buildSiblings(
  blockId: string,
  allBlocks: ReadonlyArray<{ id: string; expression: string; isCombination: boolean }>,
  blocksDraft: BlocksDraft | null
): SiblingBlock[] {
  const siblings: SiblingBlock[] = [];
  for (const b of allBlocks) {
    if (b.isCombination || b.id === blockId) {
      continue;
    }
    siblings.push({
      id: b.id,
      label: blockLabelFor(blocksDraft, b.id, false),
      expression: b.expression,
    });
  }
  return siblings;
}

function buildBlockRow(
  doc: Document,
  blockId: string,
  expression: string,
  isCombination: boolean,
  editor: FormulaEditor,
  callbacks: EditViewCallbacks,
  renderCtx: BlockRenderContext,
  allBlocks: ReadonlyArray<{ id: string; expression: string; isCombination: boolean }>
): HTMLElement {
  // 概念ブロックの編集／AI 改善パネルを開いたときに展開するインスペクタの生成器。
  // 結合行には付けない。callback 未注入時は buildBlockInspector が null を返す。
  const makeInspector = (): HTMLElement | null => {
    if (isCombination) {
      return null;
    }
    return buildBlockInspector(doc, {
      blockId,
      expression,
      siblings: buildSiblings(blockId, allBlocks, renderCtx.blocksDraft),
      onCountHits: callbacks.onCountHits,
      onFetchMeshTrees: callbacks.onFetchMeshTrees,
      onFetchMeshChildren: callbacks.onFetchMeshChildren,
      onFetchMeshLabels: callbacks.onFetchMeshLabels,
      // MeSH ブラウザからの追加・削除はこのブロックの式を書き換えて自動保存へ流す。
      // 適用時に重複句を掃除し（dedupe）、MeSH 句を先・フリーワードを後に並べ替える（sort）。
      onApplyExpression: (next: string): void => {
        try {
          const normalized = sortOperandsMeshFirst(dedupeOperands(next));
          editor.setMd(applyBlockImprovement(editor.getMd(), blockId, normalized));
        } catch {
          // 不正な式（空など）は適用しない。UI 側で空は弾いている。
        }
      },
      hitsCache: renderCtx.hitsCache,
      meshTreeCache: renderCtx.meshTreeCache,
      meshChildrenCache: renderCtx.meshChildrenCache,
      meshLabelCache: renderCtx.meshLabelCache,
      meshExpandedState: renderCtx.meshExpandedState,
    });
  };
  const li = doc.createElement('li');
  li.className = 'edit__block-row';
  // 結合行（最終検索式）は draft 画面と同様に強調表示する
  if (isCombination) {
    li.classList.add('edit__block-row--combination');
  }
  li.setAttribute('data-block-id', blockId);

  const header = doc.createElement('div');
  header.className = 'edit__block-header';

  // `#N` とその概念ブロック名（ブロック承認画面のラベル）。結合行は「結合」と示す。
  const idGroup = doc.createElement('div');
  idGroup.className = 'edit__block-idgroup';
  const idSpan = doc.createElement('span');
  idSpan.className = 'edit__block-id';
  idSpan.textContent = `#${blockId}`;
  idGroup.appendChild(idSpan);
  const label = blockLabelFor(renderCtx.blocksDraft, blockId, isCombination);
  const labelSpan = doc.createElement('span');
  labelSpan.className = 'edit__block-label';
  if (label) {
    labelSpan.textContent = label;
  } else if (isCombination) {
    labelSpan.textContent = '結合行';
    labelSpan.classList.add('edit__block-label--muted');
  }
  idGroup.appendChild(labelSpan);

  // 概念ブロックの単体ヒット数（リアルタイム）。結合行や onCountHits 未注入では出さない。
  if (!isCombination && callbacks.onCountHits) {
    idGroup.appendChild(buildHitsBadge(doc, expression, callbacks.onCountHits, renderCtx.hitsCache));
  }
  header.appendChild(idGroup);

  const tools = doc.createElement('div');
  tools.className = 'edit__block-tools';
  // 編集に入る導線は鉛筆 1 つに統一する。開くと手編集フォームと AI 改善フォームが同時に出る。
  const editToggle = doc.createElement('button');
  editToggle.type = 'button';
  editToggle.className = 'edit__block-edit-toggle';
  editToggle.textContent = '✏️';
  editToggle.title = 'このブロックを編集（手編集と AI 改善）';
  editToggle.setAttribute('aria-label', `ブロック #${blockId} を編集`);
  tools.appendChild(editToggle);
  header.appendChild(tools);
  li.appendChild(header);

  const currentPre = doc.createElement('pre');
  currentPre.className = 'edit__block-current';
  // MeSH 語はクリックで MeSH ブラウザに飛ぶリンク、フリーワードは色分け表示にする。
  renderExpressionInto(currentPre, expression);
  li.appendChild(currentPre);

  // 手編集フォーム + インスペクタ用スロット（鉛筆で開く）
  const editSlot = doc.createElement('div');
  editSlot.className = 'edit__block-edit';
  li.appendChild(editSlot);

  // AI 改善（指示フォーム + 提案）用スロット
  const aiSlot = doc.createElement('div');
  aiSlot.className = 'edit__block-ai';
  aiSlot.setAttribute('aria-live', 'polite');
  li.appendChild(aiSlot);

  // 統合編集パネルを閉じる（手編集・AI フォーム・AI パネル状態をすべて畳む）。
  function closeCombinedPanel(): void {
    renderCtx.openEditPanels.delete(blockId);
    renderCtx.aiPanels.delete(blockId);
    closeInlineEdit(editSlot, currentPre, editToggle);
    aiSlot.innerHTML = '';
  }

  // 統合編集パネルを開く。手編集フォーム（+ インスペクタ）と AI 改善フォーム（+ 提案）を同時に出す。
  // focus=true はユーザー操作で開いたとき（入力欄へフォーカス）、false は再描画での復元時。
  const openCombinedPanel = (focus: boolean): void => {
    openInlineEdit(
      doc,
      editSlot,
      currentPre,
      editToggle,
      blockId,
      expression,
      editor,
      makeInspector,
      focus,
      closeCombinedPanel
    );
    renderAiArea(doc, aiSlot, blockId, expression, editor, callbacks, renderCtx, focus);
  };

  // 再描画をまたいでパネル開閉状態を保持し、開いていれば作り直す（AI 提案も aiPanels から復元される）。
  if (renderCtx.openEditPanels.has(blockId)) {
    openCombinedPanel(false);
  }

  const toggleCombinedPanel = (): void => {
    if (renderCtx.openEditPanels.has(blockId)) {
      closeCombinedPanel();
    } else {
      renderCtx.openEditPanels.add(blockId);
      openCombinedPanel(true);
    }
  };

  editToggle.addEventListener('click', toggleCombinedPanel);

  // 鉛筆だけでなく、ブロック行（ヘッダ・式の行）クリックでも編集パネルを開閉する。
  // リンク（MeSH）・ボタン（鉛筆等）・入力欄・展開済みパネル内のクリックは対象外にし、
  // テキスト選択中（ドラッグ）も無視する。
  const rowToggleHandler = (ev: Event): void => {
    const target = ev.target as Element | null;
    if (
      target?.closest(
        'a, button, input, textarea, select, .edit__block-edit, .edit__block-ai, .edit__combo-check'
      )
    ) {
      return;
    }
    const selection = doc.getSelection?.();
    if (selection && selection.type === 'Range' && selection.toString() !== '') {
      return;
    }
    toggleCombinedPanel();
  };
  header.addEventListener('click', rowToggleHandler);
  currentPre.addEventListener('click', rowToggleHandler);

  // 結合行には最終検索式の実検索 + シード捕捉確認を付ける（表示時・編集後に自動実行）。
  if (isCombination && callbacks.onCheckCombination) {
    li.appendChild(
      buildCombinationCheck(doc, editor, callbacks.onCheckCombination, renderCtx.comboCache)
    );
  }

  return li;
}

/**
 * 結合行（最終検索式）用の「検索 + シード捕捉確認」UI。
 *
 * 概念ブロックのヒット数バッジと同じく、**表示時に自動実行**する。編集でブロック一覧が
 * 再描画されるたびにこの UI も作り直されるので、その都度「新しい md」で自動的に再確認される
 * （= 表示時 + 編集後に自動）。同一 md の重複 esearch は md→結果キャッシュで防ぐ。
 * 「再検索」ボタンはキャッシュを無視して明示的に取り直すための手段として残す。
 */
function buildCombinationCheck(
  doc: Document,
  editor: FormulaEditor,
  onCheckCombination: NonNullable<EditViewCallbacks['onCheckCombination']>,
  cache: Map<string, Promise<CombinationCheckResult>>
): HTMLElement {
  const wrap = doc.createElement('div');
  wrap.className = 'edit__combo-check';

  const btn = doc.createElement('button');
  btn.type = 'button';
  btn.className = 'edit__combo-check-btn';
  btn.textContent = '再検索';
  btn.title = '結合行を検索し直してシード捕捉を再確認します（表示時と編集後は自動で実行されます）。';
  wrap.appendChild(btn);

  const result = doc.createElement('div');
  result.className = 'edit__combo-check-result';
  result.setAttribute('aria-live', 'polite');
  wrap.appendChild(result);

  /** force=true でキャッシュを無視して取り直す。false なら同一 md のキャッシュを再利用。 */
  function run(force: boolean): void {
    const md = editor.getMd();
    btn.disabled = true;
    result.className = 'edit__combo-check-result edit__combo-check-result--pending';
    result.textContent = '検索中…';
    let pending = force ? undefined : cache.get(md);
    if (!pending) {
      // 呼び出しは microtask に逃がし、同期 throw も reject として扱えるようにする。
      pending = Promise.resolve().then(() => onCheckCombination(md));
      cache.set(md, pending);
      // 失敗は握りつぶさず、次の表示・編集・再検索で再試行できるよう cache から外す。
      pending.catch(() => cache.delete(md));
    }
    pending
      .then((res) => {
        renderCombinationResult(doc, result, res);
      })
      .catch((err: unknown) => {
        result.className = 'edit__combo-check-result edit__combo-check-result--error';
        result.textContent = `確認に失敗しました: ${formatError(err)}`;
      })
      .finally(() => {
        btn.disabled = false;
      });
  }

  btn.addEventListener('click', () => run(true));
  // 表示時に自動実行（編集による再描画のたびに、新しい md で自動的に再確認される）。
  run(false);

  return wrap;
}

/** 結合行チェック結果（総ヒット数・捕捉率・捕捉/未捕捉 PMID）を描画する。 */
function renderCombinationResult(
  doc: Document,
  result: HTMLElement,
  res: CombinationCheckResult
): void {
  result.innerHTML = '';
  const allCaptured = res.eligibleSeedCount > 0 && res.missedPmids.length === 0;
  result.className = `edit__combo-check-result ${
    res.eligibleSeedCount === 0
      ? 'edit__combo-check-result--info'
      : allCaptured
        ? 'edit__combo-check-result--ok'
        : 'edit__combo-check-result--warn'
  }`;

  const hits = doc.createElement('p');
  hits.className = 'edit__combo-check-hits';
  hits.textContent = `総ヒット数: ${res.totalHits.toLocaleString()} 件`;
  result.appendChild(hits);

  const capture = doc.createElement('p');
  capture.className = 'edit__combo-check-capture';
  if (res.eligibleSeedCount === 0) {
    capture.textContent = '有効なシード論文が無いため捕捉率は確認できません（/seeds で登録してください）。';
  } else {
    const ratePct = Math.round(res.captureRate * 1000) / 10;
    const mark = allCaptured ? '✓' : '⚠';
    capture.textContent = `${mark} シード捕捉率: ${ratePct}%（${res.capturedPmids.length}/${res.eligibleSeedCount} 件）`;
  }
  result.appendChild(capture);

  if (res.missedPmids.length > 0) {
    const missed = doc.createElement('p');
    missed.className = 'edit__combo-check-missed';
    missed.textContent = `未捕捉 PMID: ${res.missedPmids.join(', ')}`;
    result.appendChild(missed);
  }
}

/**
 * 概念ブロック式のヒット数バッジ。生成時に「計測中…」を出し、esearch 結果が返ったら
 * 件数（またはエラー）へ差し替える。キャッシュ経由で同一式の重複計測を避ける。
 */
function buildHitsBadge(
  doc: Document,
  expression: string,
  onCountHits: NonNullable<EditViewCallbacks['onCountHits']>,
  cache: Map<string, Promise<number>>
): HTMLElement {
  const badge = doc.createElement('span');
  badge.className = 'edit__block-hits edit__block-hits--pending';
  badge.setAttribute('aria-live', 'polite');
  badge.textContent = '計測中…';
  countHitsCached(onCountHits, cache, expression)
    .then((count) => {
      badge.className = 'edit__block-hits edit__block-hits--done';
      badge.textContent = `${count.toLocaleString()} 件`;
    })
    .catch((err: unknown) => {
      badge.className = 'edit__block-hits edit__block-hits--error';
      badge.textContent = '件数エラー';
      badge.title = formatError(err);
    });
  return badge;
}

/**
 * 鉛筆で開く統合編集パネルの「手編集」部分（テキストエリア + 保存 + インスペクタ）を構築する。
 * 「閉じる」は統合パネル全体を畳む onClose に委譲する（手編集と AI 改善を一体で開閉するため）。
 * focus=true のときだけ入力欄へフォーカスする（再描画での復元時は false でフォーカスを奪わない）。
 */
function openInlineEdit(
  doc: Document,
  slot: HTMLElement,
  currentPre: HTMLElement,
  editToggle: HTMLButtonElement,
  blockId: string,
  expression: string,
  editor: FormulaEditor,
  makeInspector: () => HTMLElement | null,
  focus: boolean,
  onClose: () => void
): void {
  slot.innerHTML = '';
  currentPre.style.display = 'none';
  editToggle.setAttribute('aria-expanded', 'true');

  const form = doc.createElement('div');
  form.className = 'edit__block-edit-form';
  const heading = doc.createElement('p');
  heading.className = 'edit__block-edit-heading';
  heading.textContent = '手で編集';
  form.appendChild(heading);
  const input = doc.createElement('textarea');
  input.className = 'edit__block-edit-input';
  input.rows = 3;
  input.value = expression;
  input.setAttribute('aria-label', `ブロック #${blockId} の式`);
  form.appendChild(input);

  const editActions = doc.createElement('div');
  editActions.className = 'edit__block-edit-actions';
  const saveBtn = doc.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'edit__block-edit-save';
  saveBtn.textContent = '保存';
  const cancelBtn = doc.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'edit__block-edit-cancel';
  cancelBtn.textContent = '閉じる';
  editActions.appendChild(saveBtn);
  editActions.appendChild(cancelBtn);
  form.appendChild(editActions);

  const editError = doc.createElement('p');
  editError.className = 'edit__block-edit-error';
  editError.setAttribute('aria-live', 'polite');
  form.appendChild(editError);

  slot.appendChild(form);
  // 編集に入った瞬間にインスペクタを展開する（当該ブロックの MeSH ツリー / フリーワード Δ）。
  const inspector = makeInspector();
  if (inspector) {
    slot.appendChild(inspector);
  }
  if (focus) {
    input.focus();
  }

  saveBtn.addEventListener('click', () => {
    const next = input.value.trim();
    if (next === '') {
      editError.textContent = '式が空です。内容を入力してください。';
      return;
    }
    try {
      const updated = applyBlockImprovement(editor.getMd(), blockId, next);
      // setMd がブロック一覧を丸ごと再描画する。openEditPanels は保持されるのでパネルは開いたまま、
      // 新しい式で再生成される。
      editor.setMd(updated);
    } catch (err) {
      editError.textContent = `保存に失敗しました: ${formatError(err)}`;
    }
  });

  cancelBtn.addEventListener('click', () => {
    onClose();
  });
}

function closeInlineEdit(
  slot: HTMLElement,
  currentPre: HTMLElement,
  editToggle: HTMLButtonElement
): void {
  slot.innerHTML = '';
  currentPre.style.display = '';
  editToggle.removeAttribute('aria-expanded');
}

/**
 * 再描画をまたいで保持している AI 改善パネルの状態を、与えられた（最新の）スロットに描画する。
 * pending / proposal / error の各状態を、毎回の再描画で同じ見た目に復元できるようにする。
 */
function materializeAiPanel(
  doc: Document,
  slot: HTMLElement,
  panel: AiPanelState,
  blockId: string,
  editor: FormulaEditor,
  renderCtx: BlockRenderContext
): void {
  slot.innerHTML = '';
  if (panel.kind === 'pending') {
    const pending = doc.createElement('p');
    pending.className = 'edit__block-pending';
    pending.textContent = '改善提案を取得中…';
    slot.appendChild(pending);
    return;
  }
  if (panel.kind === 'error') {
    const errEl = doc.createElement('p');
    errEl.className = 'edit__block-error';
    errEl.textContent = `改善提案の取得に失敗しました: ${panel.message}`;
    slot.appendChild(errEl);
    return;
  }
  renderProposal(doc, slot, blockId, editor, panel.result, panel.baseFormulaMd, renderCtx);
}

/**
 * 統合編集パネルの「AI 改善」部分（指示フォーム + 提案サブ領域）を aiSlot に構築する。
 * onImproveBlock が無ければ何も出さない。再描画での復元時も毎回ここから組み直すので、
 * 提案は aiPanels から、フォームは都度新規に作られる。
 */
function renderAiArea(
  doc: Document,
  aiSlot: HTMLElement,
  blockId: string,
  expression: string,
  editor: FormulaEditor,
  callbacks: EditViewCallbacks,
  renderCtx: BlockRenderContext,
  focus: boolean
): void {
  aiSlot.innerHTML = '';
  if (!callbacks.onImproveBlock) {
    return;
  }
  const formWrap = doc.createElement('div');
  formWrap.className = 'edit__block-ai-form-wrap';
  aiSlot.appendChild(formWrap);
  openAiPromptForm(
    doc,
    formWrap,
    blockId,
    expression,
    editor,
    callbacks.onImproveBlock,
    callbacks.onGetImproveContext,
    renderCtx,
    focus
  );
  // AI 提案（pending / proposal / error）の描画先。refreshPanel はこのサブ領域だけを作り直す。
  const proposalWrap = doc.createElement('div');
  proposalWrap.className = 'edit__block-ai-proposal';
  proposalWrap.setAttribute('aria-live', 'polite');
  aiSlot.appendChild(proposalWrap);
  const panel = renderCtx.aiPanels.get(blockId);
  if (panel) {
    materializeAiPanel(doc, proposalWrap, panel, blockId, editor, renderCtx);
  }
}

/**
 * AI 改善の指示入力フォーム（指示文 + 「AI に渡す内容を見る」開示 + 「改善案を取得」）。
 * 「改善案を取得」で onImproveBlock を呼び、結果は aiPanels（再描画耐性あり）へ反映し、
 * 提案サブ領域を refreshPanel で作り直す。パネルの開閉自体は鉛筆トグルが受け持つ。
 */
function openAiPromptForm(
  doc: Document,
  slot: HTMLElement,
  blockId: string,
  expression: string,
  editor: FormulaEditor,
  onImproveBlock: NonNullable<EditViewCallbacks['onImproveBlock']>,
  onGetImproveContext: EditViewCallbacks['onGetImproveContext'],
  renderCtx: BlockRenderContext,
  focus: boolean
): void {
  const form = doc.createElement('div');
  form.className = 'edit__block-ai-form';

  const heading = doc.createElement('p');
  heading.className = 'edit__block-ai-heading';
  heading.textContent = 'AI に相談';
  form.appendChild(heading);

  const instructionLabel = doc.createElement('label');
  instructionLabel.className = 'edit__block-ai-instruction-label';
  instructionLabel.textContent = 'AI への指示（任意）:';
  const instruction = doc.createElement('textarea');
  instruction.className = 'edit__block-ai-instruction';
  instruction.rows = 2;
  instruction.placeholder = '例: 同義語をもっと増やして / MeSH を減らして tiab 中心に';
  instructionLabel.appendChild(instruction);
  form.appendChild(instructionLabel);

  // AI に渡る文脈の開示（callback があれば）。SeedPapers 読み取りを伴うので非同期で埋める。
  if (onGetImproveContext) {
    const details = doc.createElement('details');
    details.className = 'edit__block-ai-context';
    const summary = doc.createElement('summary');
    summary.textContent = 'AI に渡す内容を見る';
    details.appendChild(summary);
    const loading = doc.createElement('p');
    loading.className = 'edit__block-ai-context-loading';
    loading.textContent = '読み込み中…';
    details.appendChild(loading);
    form.appendChild(details);
    onGetImproveContext(blockId)
      .then((context) => {
        loading.remove();
        details.appendChild(buildContextBody(doc, context, expression));
      })
      .catch(() => {
        loading.textContent = '文脈の取得に失敗しました（改善は実行できます）。';
      });
  }

  const aiActions = doc.createElement('div');
  aiActions.className = 'edit__block-ai-actions';
  const submitBtn = doc.createElement('button');
  submitBtn.type = 'button';
  submitBtn.className = 'edit__block-ai-submit';
  submitBtn.textContent = '改善案を取得';
  aiActions.appendChild(submitBtn);
  form.appendChild(aiActions);

  slot.appendChild(form);
  if (focus) {
    instruction.focus();
  }

  submitBtn.addEventListener('click', () => {
    submitBtn.disabled = true;
    const pendingInstruction = instruction.value;
    // 受信時点の md を accept 時の base として握る（その後の再描画で editor が作り直されても不変）。
    const base = editor.getMd();
    // 状態を aiPanels に置き、最新の DOM の提案サブ領域を作り直す（LLM 完了時のコスト集計
    // setState による全ビュー再描画で提案が消えないようにするための肝）。
    renderCtx.aiPanels.set(blockId, { kind: 'pending' });
    renderCtx.refreshPanel(blockId);
    onImproveBlock({ blockId, instruction: pendingInstruction })
      .then((result) => {
        renderCtx.aiPanels.set(blockId, { kind: 'proposal', result, baseFormulaMd: base });
        renderCtx.refreshPanel(blockId);
      })
      .catch((err: unknown) => {
        renderCtx.aiPanels.set(blockId, { kind: 'error', message: formatError(err) });
        renderCtx.refreshPanel(blockId);
      });
  });
}

/** 「AI に渡す内容を見る」の中身。context が null なら現式のみ示す。 */
function buildContextBody(
  doc: Document,
  context: BlockImprovementContext | null,
  fallbackExpression: string
): HTMLElement {
  const wrapper = doc.createElement('div');
  wrapper.className = 'edit__block-ai-context-body';

  const dl = doc.createElement('dl');
  dl.className = 'edit__block-ai-context-list';
  const rq = context?.researchQuestion?.trim();
  const label = context?.blockLabel?.trim();
  const desc = context?.blockDescription?.trim();
  const current = (context?.currentExpression ?? fallbackExpression).trim();
  appendContextItem(doc, dl, 'RQ', rq && rq !== '' ? rq : '(未設定)');
  appendContextItem(doc, dl, 'ブロックの役割', label && label !== '' ? label : '(自動推定)');
  appendContextItem(doc, dl, '説明', desc && desc !== '' ? desc : '(自動推定)');
  appendContextItem(doc, dl, '現在の式', current);
  const hits = context?.currentHits;
  appendContextItem(
    doc,
    dl,
    '現在のヒット数',
    hits === null || hits === undefined ? '(未計測)' : `${hits.toLocaleString('en-US')} 件`
  );
  wrapper.appendChild(dl);

  // キーワード別ヒット数 + 寄与（Δ・削除候補/低収量）。編集画面のインスペクタと同じ実数。
  const keywordHits = context?.keywordHits ?? [];
  if (keywordHits.length > 0) {
    const kwHeading = doc.createElement('p');
    kwHeading.className = 'edit__block-ai-context-subheading';
    kwHeading.textContent = `キーワード別ヒット数（${keywordHits.length} 語）`;
    wrapper.appendChild(kwHeading);
    const kwList = doc.createElement('ul');
    kwList.className = 'edit__block-ai-context-keywords';
    for (const kw of keywordHits) {
      const item = doc.createElement('li');
      const kindLabel = kw.kind === 'mesh' ? 'MeSH' : 'tiab';
      let text =
        kw.hits === null
          ? `${kw.term} [${kindLabel}]: (未計測)`
          : `${kw.term} [${kindLabel}]: ${kw.hits.toLocaleString('en-US')} 件`;
      if (kw.delta !== null && kw.delta !== undefined) {
        text += `・純増Δ +${kw.delta.toLocaleString('en-US')}`;
      }
      if (kw.hits === 0) {
        item.classList.add('edit__block-ai-context-keyword--zero');
        text += ' ⚠ 0件';
      } else if (kw.status === 'redundant') {
        item.classList.add('edit__block-ai-context-keyword--redundant');
        text += ' ⚠ 削除候補';
      } else if (kw.status === 'lowYield') {
        item.classList.add('edit__block-ai-context-keyword--lowyield');
        text += ' △ ほぼ寄与なし';
      }
      item.textContent = text;
      kwList.appendChild(item);
    }
    wrapper.appendChild(kwList);
    const dedup = context?.freewordDedupTotal;
    if (dedup !== null && dedup !== undefined) {
      const total = doc.createElement('p');
      total.className = 'edit__block-ai-context-keyword-total';
      total.textContent = `フリーワード OR 合計（重複除去後）: ${dedup.toLocaleString('en-US')} 件`;
      wrapper.appendChild(total);
    }
  }

  // シード論文
  const seeds = context?.seedPapers ?? [];
  const seedsHeading = doc.createElement('p');
  seedsHeading.className = 'edit__block-ai-context-subheading';
  seedsHeading.textContent = `シード論文（${seeds.length} 件）`;
  wrapper.appendChild(seedsHeading);
  if (seeds.length === 0) {
    const none = doc.createElement('p');
    none.className = 'edit__block-ai-context-empty';
    none.textContent = '(登録なし)';
    wrapper.appendChild(none);
  } else {
    const seedList = doc.createElement('ul');
    seedList.className = 'edit__block-ai-context-seeds';
    for (const seed of seeds) {
      const item = doc.createElement('li');
      const tag = seed.source === 'interactive' ? '対話拡張' : '初期';
      item.textContent = `PMID ${seed.pmid}（${tag}・${seed.decision}）: ${seed.title}`;
      seedList.appendChild(item);
    }
    wrapper.appendChild(seedList);
  }

  // 直近の検証捕捉情報
  const validation = context?.validation ?? null;
  const valHeading = doc.createElement('p');
  valHeading.className = 'edit__block-ai-context-subheading';
  valHeading.textContent = '直近の検証結果';
  wrapper.appendChild(valHeading);
  const valBody = doc.createElement('p');
  valBody.className = 'edit__block-ai-context-validation';
  if (validation === null) {
    valBody.textContent = '(未検証)';
  } else {
    const ratePct = Math.round(validation.captureRate * 1000) / 10;
    const total = validation.capturedPmids.length + validation.missedPmids.length;
    const missed =
      validation.missedPmids.length === 0 ? 'なし' : validation.missedPmids.join(', ');
    valBody.textContent = `捕捉率 ${ratePct}%（${validation.capturedPmids.length}/${total}）／取りこぼし PMID: ${missed}`;
  }
  wrapper.appendChild(valBody);

  return wrapper;
}

function appendContextItem(
  doc: Document,
  dl: HTMLElement,
  term: string,
  value: string
): void {
  const dt = doc.createElement('dt');
  dt.textContent = term;
  const dd = doc.createElement('dd');
  dd.textContent = value;
  dl.appendChild(dt);
  dl.appendChild(dd);
}

/**
 * 句単位の増減サマリー。「削除した語（N）」「追加した語（M）」を色付きチップで列挙する。
 * 語の増減が無い（語順・記法だけの変更）ときはその旨を 1 行で示す。
 */
function buildDiffSummary(doc: Document, removed: string[], added: string[]): HTMLElement {
  const wrap = doc.createElement('div');
  wrap.className = 'edit__block-diff-summary';
  if (removed.length === 0 && added.length === 0) {
    const none = doc.createElement('p');
    none.className = 'edit__block-diff-summary-none';
    none.textContent = '語の増減はありません（語順・記法のみの変更）。';
    wrap.appendChild(none);
    return wrap;
  }
  wrap.appendChild(buildDiffSummaryRow(doc, 'removed', '削除した語', removed));
  wrap.appendChild(buildDiffSummaryRow(doc, 'added', '追加した語', added));
  return wrap;
}

/** 増減サマリーの 1 行（削除 or 追加）。terms が空なら「なし」を出す。 */
function buildDiffSummaryRow(
  doc: Document,
  status: 'removed' | 'added',
  label: string,
  terms: string[]
): HTMLElement {
  const row = doc.createElement('div');
  row.className = `edit__block-diff-summary-row edit__block-diff-summary-row--${status}`;
  const head = doc.createElement('span');
  head.className = 'edit__block-diff-summary-label';
  head.textContent = `${label}（${terms.length}）`;
  row.appendChild(head);
  if (terms.length === 0) {
    const none = doc.createElement('span');
    none.className = 'edit__block-diff-chip edit__block-diff-chip--empty';
    none.textContent = 'なし';
    row.appendChild(none);
    return row;
  }
  for (const term of terms) {
    const chip = doc.createElement('span');
    chip.className = `formula-diff__term formula-diff__term--${status} edit__block-diff-chip`;
    renderExpressionInto(chip, term);
    row.appendChild(chip);
  }
  return row;
}

/**
 * improve-block 結果の diff を表示し、accept / reject ボタンを用意する。
 * baseFormulaMd は提案受信時点の md で、accept 時はその base に対して
 * applyBlockImprovement を当てて差し替える。accept / reject では aiPanels から
 * 当該ブロックの状態を消し、最新の DOM へ再描画する。
 */
function renderProposal(
  doc: Document,
  slot: HTMLElement,
  blockId: string,
  editor: FormulaEditor,
  result: BlockImprovementResult,
  baseFormulaMd: string,
  renderCtx: BlockRenderContext
): void {
  slot.innerHTML = '';
  const rationale = doc.createElement('p');
  rationale.className = 'edit__block-rationale';
  rationale.textContent = result.rationale === '' ? '（改善ポイントの説明なし）' : result.rationale;
  slot.appendChild(rationale);

  // 句（OR/AND 区切り）単位の差分。何が削除/追加されたかを一目で分かるようにする。
  const exprDiff = diffExpressions(result.currentExpression, result.proposedExpression);

  // まず増減サマリー（削除した語 / 追加した語）を上に出す。
  slot.appendChild(buildDiffSummary(doc, exprDiff.removed, exprDiff.added));

  const diff = doc.createElement('div');
  diff.className = 'edit__block-diff';
  const before = doc.createElement('div');
  before.className = 'edit__block-diff-before';
  const beforeHeader = doc.createElement('strong');
  beforeHeader.textContent = 'Before（現在）:';
  before.appendChild(beforeHeader);
  const beforePre = doc.createElement('pre');
  // 削除句は取り消し線＋赤、変更なしの句は淡色で、差分が目立つように描画する。
  renderDiffSideInto(beforePre, exprDiff.beforeTokens);
  before.appendChild(beforePre);

  const after = doc.createElement('div');
  after.className = 'edit__block-diff-after';
  const afterHeader = doc.createElement('strong');
  afterHeader.textContent = 'After（提案）:';
  after.appendChild(afterHeader);
  const afterPre = doc.createElement('pre');
  // 追加句は緑で強調、変更なしの句は淡色で描画する。
  renderDiffSideInto(afterPre, exprDiff.afterTokens);
  after.appendChild(afterPre);

  diff.appendChild(before);
  diff.appendChild(after);
  slot.appendChild(diff);

  const actions = doc.createElement('div');
  actions.className = 'edit__block-actions';

  const acceptBtn = doc.createElement('button');
  acceptBtn.type = 'button';
  acceptBtn.className = 'edit__block-accept';
  acceptBtn.textContent = 'この提案で置き換える';
  const rejectBtn = doc.createElement('button');
  rejectBtn.type = 'button';
  rejectBtn.className = 'edit__block-reject';
  rejectBtn.textContent = '破棄';

  // proposed == current なら accept の意味が無いので無効化
  if (result.proposedExpression.trim() === '' ||
      result.proposedExpression.trim() === result.currentExpression.trim()) {
    acceptBtn.disabled = true;
    acceptBtn.title = '提案が空、または現式と同じです';
  }

  actions.appendChild(acceptBtn);
  actions.appendChild(rejectBtn);
  slot.appendChild(actions);

  const feedback = doc.createElement('p');
  feedback.className = 'edit__block-feedback';
  feedback.setAttribute('aria-live', 'polite');
  slot.appendChild(feedback);

  acceptBtn.addEventListener('click', () => {
    let next: string;
    try {
      next = applyBlockImprovement(baseFormulaMd, blockId, result.proposedExpression);
    } catch (err) {
      feedback.textContent = `置き換えに失敗しました: ${formatError(err)}`;
      return;
    }
    // 提案を消してから md を反映する。setMd がブロック一覧を再描画し、
    // パネルが消えた状態の新しい式で再生成される。
    renderCtx.aiPanels.delete(blockId);
    editor.setMd(next);
  });

  rejectBtn.addEventListener('click', () => {
    renderCtx.aiPanels.delete(blockId);
    renderCtx.refreshPanel(blockId);
  });
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
