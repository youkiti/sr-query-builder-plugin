/**
 * ブロック・インスペクタ（requirements: 検索式編集の MeSH/フリーワード可視化）。
 *
 * 編集画面（鉛筆インライン編集）または AI 改善パネルを **開いたときだけ** 当該ブロックの
 * 下に展開する補助ビュー。常時表示すると画面が縦に伸びすぎるため、編集に入った瞬間に発動する。
 *
 * 3 つのセクションで構成する:
 *
 * 1. **MeSH ツリー**: そのブロックの MeSH 用語が MeSH 階層のどこに乗っているかを
 *    インデントツリーで描画する（祖先ノードは文脈としてグレー表示）。
 *    - 別カテゴリにルートが分かれることで「ずれ」が見える
 *    - 祖先 explode 用語の子孫は ⚠ 重複（冗長）として注記する
 *    - 各用語の個別ヒット数を併記する
 * 2. **フリーワード Δ 表**: 個別ヒット数の多い順に並べ、上から OR で累積したときの
 *    純増（Δ）を行ごとに出す。Δ=0 は削除候補、Δ 極小は低収量として色分けする。
 * 3. **他ブロックとの重複**: 同じ MeSH / フリーワードを使っている別ブロックを 1 行で示す。
 *    共有語ごとに「削除」ボタンを添え、AI を使わずその場でブロック式から外せる（issue #89）。
 *    同じ共有語の情報は「AI に改善させる」提出時に improve-block skill へも渡す
 *    （editView.ts の openAiPromptForm 参照）。
 *
 * 計測は注入された `onCountHits`（esearch count）と `onFetchMeshTrees`（db=mesh tree number）に
 * 委譲し、結果は edit view から渡されるキャッシュで使い回す（同一式の重複 esearch を防ぐ）。
 */

import {
  analyzeFreewordDelta,
  meshCategoryName,
  type BlockMeshTermMeta,
  type FreewordDeltaResult,
  type FreewordDeltaRow,
  type FreewordTermInput,
  type MeshTreeEntry,
} from '@/features/validation';
import type { MeshTreeNode } from '@/lib/ncbi';
import {
  extractBlockTerms, computeSiblingOverlapsFromTerms, freewordCacheKey,
  meshHitQuery,
  type ParsedMeshTerm, type ParsedBlockTerms, type SiblingBlock, type SharedTerm,
} from '@/features/validation/blockTerms';
export {
  extractBlockTerms, collectMeasuredContext, computeSiblingOverlaps,
  type MeasuredKeywordHit, type MeasuredBlockContext,
  type SiblingBlock, type SharedTerm, type SiblingOverlap,
} from '@/features/validation/blockTerms';
import {
  buildBlockMeshContext, buildMeshBranchPath,
} from '@/features/validation/meshContext';
import {
  addMeshDescriptor,
  hasMeshDescriptor,
  removeMeshDescriptor,
  replaceMeshDescriptor,
} from './meshExpressionEdit';
import { findOperandByText, removeOperandAt, setOperandTerm } from './operandEdit';

/** インスペクタが必要とする計測 callback とキャッシュ。 */
export interface BlockInspectorDeps {
  /** 式（または語）の esearch ヒット数。フリーワード Δ・MeSH 個別件数に使う */
  onCountHits?: (expression: string) => Promise<number>;
  /** MeSH descriptor → tree numbers の取得（db=mesh） */
  onFetchMeshTrees?: (descriptors: string[]) => Promise<MeshTreeEntry[]>;
  /** tree number → 子ノード（1 段下・名前付き）の取得（MeSH RDF）。MeSH ブラウザのナビに使う */
  onFetchMeshChildren?: (treeNumber: string) => Promise<MeshTreeNode[]>;
  /** tree number 群 → ノード（descriptor + 名前）のバッチ逆引き（MeSH RDF）。祖先の名前表示に使う */
  onFetchMeshLabels?: (treeNumbers: string[]) => Promise<Map<string, MeshTreeNode>>;
  /**
   * MeSH ブラウザからの置換 / OR追加でブロック式を差し替える。注入された場合のみ
   * ノード名クリック（置換）・「OR追加」ボタンを出す。第 1 引数は当該ブロックの新しい式全文。
   * 第 2 引数 onError は、差し替えが拒否された（例: 式が空になる）ときに呼び出し元へ理由を
   * 伝えるための任意コールバック（issue #89。既存の呼び出し箇所は渡さなくてもよい＝
   * 無言で失敗する従来どおりの挙動のまま）。
   */
  onApplyExpression?: (nextExpression: string, onError?: (message: string) => void) => void;
  /** 式→件数キャッシュ（edit view インスタンスと共有） */
  hitsCache: Map<string, Promise<number>>;
  /**
   * hitsCache の解決済みスナップショット（edit view インスタンスと共有。issue #58 chunk 3c）。
   * hitsCache は Promise を保持するため、値が確定済みかどうかを await なしに判定できない。
   * 「AI に改善させる」の実行時は同期的に（新規 esearch を発行せず）計測済みの値だけを拾って
   * プロンプトへ渡したいため、cachedCount が解決するたびにこちらへも書き込む。
   * 省略時（呼び出し側が渡さない）はスナップショットが取れないだけで、通常の計測動作
   * （バッジ表示・Δ 計算）自体には影響しない。
   */
  hitsSnapshot?: Map<string, number>;
  /**
   * フリーワード Δ の結果キャッシュ（edit view インスタンスと共有）。キーはフリーワード語の集合。
   * 個別件数は hitsCache でキャッシュ済みでも、表全体（並べ替え＋累積 OR）はインスペクタ再構築の
   * たびに作り直され「計算中…」が一瞬戻る。語の集合が同じ式（MeSH だけ編集した等）では
   * 計算結果をそのまま使い回し、再表示時の再計算とちらつきを避ける。
   */
  freewordDeltaCache: Map<string, Promise<FreewordDeltaResult>>;
  /**
   * freewordDeltaCache の解決済みスナップショット（hitsSnapshot と同じ理由。issue #58 chunk 3c）。
   * 「AI に改善させる」がフリーワードの Δ・寄与区分をプロンプトへ渡すための同期読み出し口。
   */
  freewordDeltaSnapshot?: Map<string, FreewordDeltaResult>;
  /** descriptor 群→tree entries キャッシュ（edit view インスタンスと共有） */
  meshTreeCache: Map<string, Promise<MeshTreeEntry[]>>;
  /** tree number→子ノード キャッシュ（edit view インスタンスと共有） */
  meshChildrenCache: Map<string, Promise<MeshTreeNode[]>>;
  /** tree number 群→ラベル Map キャッシュ（edit view インスタンスと共有） */
  meshLabelCache: Map<string, Promise<Map<string, MeshTreeNode>>>;
  /**
   * blockId → 展開済み tree number 集合。MeSH ブラウザの ▸ 展開状態を、
   * 置換/追加による setMd 再描画をまたいで保持するために共有する。
   */
  meshExpandedState: Map<string, Set<string>>;
}

export interface BlockInspectorParams extends BlockInspectorDeps {
  blockId: string;
  expression: string;
  /** 自分以外の概念ブロック（結合行は含めない） */
  siblings: SiblingBlock[];
}

/**
 * ブロック・インスペクタの DOM を構築する。
 * 必要な callback が無い場合（MeSH も件数も注入されていない）は null を返し、edit view は何も足さない。
 */
export function buildBlockInspector(
  doc: Document,
  params: BlockInspectorParams
): HTMLElement | null {
  if (!params.onCountHits && !params.onFetchMeshTrees) {
    return null;
  }
  const terms = extractBlockTerms(params.expression);

  const section = doc.createElement('section');
  section.className = 'bins';
  section.setAttribute('aria-live', 'polite');

  const heading = doc.createElement('p');
  heading.className = 'bins__heading';
  heading.textContent = '🔎 このブロックのインスペクタ';
  section.appendChild(heading);

  // 1. MeSH ツリー
  if (params.onFetchMeshTrees) {
    section.appendChild(buildMeshSection(doc, terms.meshTerms, params));
  }

  // 2. フリーワード Δ
  if (params.onCountHits) {
    section.appendChild(buildFreewordSection(doc, terms.freewordTerms, params));
  }

  // 3. 他ブロックとの重複
  section.appendChild(buildOverlapSection(doc, params, terms));

  return section;
}

/** 式→件数のキャッシュ越し count。解決した値は snapshot（渡されていれば）にも同期的に残す。 */
function cachedCount(
  onCountHits: NonNullable<BlockInspectorDeps['onCountHits']>,
  cache: Map<string, Promise<number>>,
  query: string,
  snapshot?: Map<string, number>
): Promise<number> {
  const cached = cache.get(query);
  if (cached) {
    return cached;
  }
  const pending = onCountHits(query);
  cache.set(query, pending);
  pending.then((count) => snapshot?.set(query, count)).catch(() => cache.delete(query));
  return pending;
}

// ---- MeSH ブラウザ（PubMed 風インデントツリー）-----------------------------
//
// 1 ブロック内の各 MeSH 用語について、ルート〜その語までの「枝（spine）」を PubMed の
// MeSH ツリーページのようにインデント表示し、起点語の配下を展開して辿れるブラウザを作る。
//
// 操作:
// - ノード名クリック = 置換（起点語をそのノードへ差し替え。上位＝広げる / 下位＝絞る）
// - 行の「OR追加」 = そのノードを別 OR 項として足す
// - ▸/▾ = 子をその場に遅延展開（PubMed 風）
// 行アクションは hover / focus 時に出して平常時はごみごみさせない。件数は explode で常時表示。
// 展開状態は再描画をまたいで保持し、置換直後も同じツリーのまま隣の語を OR追加できる。

function buildMeshSection(
  doc: Document,
  meshTerms: ParsedMeshTerm[],
  params: BlockInspectorParams
): HTMLElement {
  const wrap = doc.createElement('div');
  wrap.className = 'bins__section bins__mesh';
  const title = doc.createElement('p');
  title.className = 'bins__section-title';
  title.textContent = 'MeSH（クリックで置換 / OR追加。▸ で下位を展開）';
  wrap.appendChild(title);

  if (meshTerms.length === 0) {
    wrap.appendChild(muted(doc, 'この式に MeSH 用語はありません。'));
    return wrap;
  }

  const body = doc.createElement('div');
  body.className = 'bins__mesh-body';
  const loading = doc.createElement('p');
  loading.className = 'bins__loading';
  loading.textContent = 'MeSH 階層を取得中…';
  body.appendChild(loading);
  wrap.appendChild(body);

  buildBlockMeshContext(meshTerms, (descriptors) => fetchMeshTreesCached(params, descriptors))
    .then(({ treeByDescriptor, analysis }) => {
      body.innerHTML = '';
      // 同じ語（descriptor）の枝はグループにまとめ、「同じ単語」だと一目で分かるようにする。
      // 1 語が複数 tree number に乗る場合（別カテゴリにも分類される語）も 1 グループに束ねる。
      for (const term of meshTerms) {
        const treeNumbers = treeByDescriptor.get(term.descriptor) ?? [];
        if (treeNumbers.length === 0) {
          // tree 未解決の語は枝を描けないので、下の unresolved 行でまとめて出す。
          continue;
        }
        body.appendChild(buildMeshGroup(doc, term.descriptor, treeNumbers, params));
      }
      // 補助情報（1〜数行）。
      body.appendChild(buildDivergenceLine(doc, analysis.categories));
      const redundancy = buildRedundancyLine(doc, analysis.termMeta);
      if (redundancy) {
        body.appendChild(redundancy);
      }
      if (analysis.unresolved.length > 0) {
        body.appendChild(
          muted(doc, `ツリー未解決（MeSH 解決不可）: ${analysis.unresolved.join(', ')}`)
        );
      }
    })
    .catch((err: unknown) => {
      body.innerHTML = '';
      body.appendChild(muted(doc, `MeSH 階層の取得に失敗しました: ${formatError(err)}`));
    });

  return wrap;
}

/** descriptor 群→tree entries のキャッシュ越し取得（キーは descriptor の昇順連結）。 */
function fetchMeshTreesCached(
  params: BlockInspectorParams,
  descriptors: string[]
): Promise<MeshTreeEntry[]> {
  const onFetch = params.onFetchMeshTrees!;
  const key = [...descriptors].sort().join('|');
  const cached = params.meshTreeCache.get(key);
  if (cached) {
    return cached;
  }
  const pending = onFetch(descriptors);
  params.meshTreeCache.set(key, pending);
  pending.catch(() => params.meshTreeCache.delete(key));
  return pending;
}

/** tree number→子ノードのキャッシュ越し取得。 */
function fetchMeshChildrenCached(
  params: BlockInspectorParams,
  treeNumber: string
): Promise<MeshTreeNode[]> {
  const onFetch = params.onFetchMeshChildren!;
  const cached = params.meshChildrenCache.get(treeNumber);
  if (cached) {
    return cached;
  }
  const pending = onFetch(treeNumber);
  params.meshChildrenCache.set(treeNumber, pending);
  pending.catch(() => params.meshChildrenCache.delete(treeNumber));
  return pending;
}

/** tree number 群→ラベル Map のキャッシュ越し取得（キーは tree number の昇順連結）。 */
function fetchMeshLabelsCached(
  params: BlockInspectorParams,
  treeNumbers: string[]
): Promise<Map<string, MeshTreeNode>> {
  const onFetch = params.onFetchMeshLabels!;
  const key = [...treeNumbers].sort().join('|');
  const cached = params.meshLabelCache.get(key);
  if (cached) {
    return cached;
  }
  const pending = onFetch(treeNumbers);
  params.meshLabelCache.set(key, pending);
  pending.catch(() => params.meshLabelCache.delete(key));
  return pending;
}

/** このブロックの「展開済み tree number 集合」を取り出す（再描画をまたいで保持）。 */
function expandedSetFor(params: BlockInspectorParams): Set<string> {
  let set = params.meshExpandedState.get(params.blockId);
  if (!set) {
    set = new Set<string>();
    params.meshExpandedState.set(params.blockId, set);
  }
  return set;
}

/**
 * 同一 MeSH 用語（同じ descriptor）の枝を 1 グループにまとめる。
 * - header に語名を出し、複数 tree number に乗る語は「N 系統」バッジを添えて
 *   「同じ単語」だと一目で分かるようにする。
 * - header の「この語を削除」ボタンで、ブロック式からその語の MeSH 句を丸ごと外す
 *   （onApplyExpression が注入されているときのみ）。
 */
function buildMeshGroup(
  doc: Document,
  descriptor: string,
  treeNumbers: string[],
  params: BlockInspectorParams
): HTMLElement {
  const group = doc.createElement('div');
  group.className = 'bins__group';
  group.setAttribute('data-descriptor', descriptor);

  const head = doc.createElement('div');
  head.className = 'bins__group-head';

  const name = doc.createElement('span');
  name.className = 'bins__group-name';
  name.textContent = descriptor;
  head.appendChild(name);

  if (treeNumbers.length > 1) {
    head.appendChild(badge(doc, `${treeNumbers.length} 系統`, 'bins__badge--multi'));
  }

  if (params.onApplyExpression) {
    const del = doc.createElement('button');
    del.type = 'button';
    del.className = 'bins__group-delete';
    del.textContent = 'この語を削除';
    del.title = `"${descriptor}" をこのブロックから外す`;
    del.addEventListener('click', () => {
      params.onApplyExpression!(removeMeshDescriptor(params.expression, descriptor));
    });
    head.appendChild(del);
  }

  group.appendChild(head);

  for (const treeNumber of treeNumbers) {
    group.appendChild(buildMeshBranch(doc, descriptor, treeNumber, params));
  }
  return group;
}

/**
 * 1 つの MeSH 用語（起点）について、ルート〜起点の枝を描き、起点配下を展開表示する。
 * 起点ラベルは既知。祖先ラベルは MeSH RDF でバッチ逆引きする。
 */
function buildMeshBranch(
  doc: Document,
  originDescriptor: string,
  originTreeNumber: string,
  params: BlockInspectorParams
): HTMLElement {
  const branch = doc.createElement('div');
  branch.className = 'bins__branch';

  const path = buildMeshBranchPath(originTreeNumber);
  const { spine, ancestors } = path;
  const renderAll = (labelByTree: Map<string, MeshTreeNode>): void => {
    branch.innerHTML = '';
    for (let depth = 0; depth < spine.length; depth += 1) {
      const tn = spine[depth]!;
      const isOrigin = tn === originTreeNumber;
      const label = isOrigin ? originDescriptor : labelByTree.get(tn)?.label ?? null;
      branch.appendChild(
        buildBranchRow(doc, {
          treeId: tn,
          label,
          depth,
          isOrigin,
          originDescriptor,
          params,
          // 枝（spine）の中間ノードは展開トグルを出さない（起点までの一本道）。
          // 起点にだけ ▸ を出し、子ノードは展開時に遅延取得する（初期表示は枝だけに留める）。
          expandable: isOrigin && !!params.onFetchMeshChildren,
        })
      );
    }
    // 起点配下の子の受け皿（▸ クリック、または保持された展開状態のときだけ埋める）。
    const childHost = doc.createElement('div');
    childHost.className = 'bins__branch-children';
    branch.appendChild(childHost);
    // 再描画をまたいで起点が展開済みなら、その場で子を描き直して開いた状態を保つ。
    if (params.onFetchMeshChildren && expandedSetFor(params).has(originTreeNumber)) {
      const originRow = branch.querySelector<HTMLElement>('.bins__row--origin');
      const toggle = originRow?.querySelector<HTMLButtonElement>('.bins__row-toggle');
      if (toggle) {
        toggle.textContent = '▾';
      }
      originRow?.setAttribute('data-expanded', 'true');
      renderChildren(doc, childHost, originTreeNumber, spine.length, originDescriptor, params);
    }
  };

  if (params.onFetchMeshLabels && ancestors.length > 0) {
    const loading = doc.createElement('p');
    loading.className = 'bins__loading';
    loading.textContent = '枝の名前を取得中…';
    branch.appendChild(loading);
    fetchMeshLabelsCached(params, ancestors)
      .then((labels) => renderAll(labels))
      .catch(() => renderAll(new Map()));
  } else {
    renderAll(new Map());
  }
  return branch;
}

/** 起点配下（または任意ノード配下）の子を遅延取得して描く。展開済みの孫は再帰展開する。 */
function renderChildren(
  doc: Document,
  host: HTMLElement,
  treeNumber: string,
  depth: number,
  originDescriptor: string,
  params: BlockInspectorParams
): void {
  host.innerHTML = '';
  const loading = doc.createElement('p');
  loading.className = 'bins__loading';
  loading.style.paddingLeft = `${depth * 16}px`;
  loading.textContent = '下位語を取得中…';
  host.appendChild(loading);

  fetchMeshChildrenCached(params, treeNumber)
    .then((children) => {
      host.innerHTML = '';
      if (children.length === 0) {
        const none = muted(doc, '（最下層）');
        none.style.paddingLeft = `${depth * 16}px`;
        host.appendChild(none);
        return;
      }
      const expanded = expandedSetFor(params);
      for (const child of children) {
        const row = buildBranchRow(doc, {
          treeId: child.treeNumber,
          label: child.label,
          depth,
          isOrigin: false,
          originDescriptor,
          params,
          expandable: child.hasChildren === true,
        });
        host.appendChild(row);
        // この子の孫を入れる受け皿。
        const sub = doc.createElement('div');
        sub.className = 'bins__branch-children';
        host.appendChild(sub);
        if (child.hasChildren === true && expanded.has(child.treeNumber)) {
          row.setAttribute('data-expanded', 'true');
          renderChildren(doc, sub, child.treeNumber, depth + 1, originDescriptor, params);
        }
      }
    })
    .catch((err: unknown) => {
      host.innerHTML = '';
      host.appendChild(muted(doc, `下位語の取得に失敗しました: ${formatError(err)}`));
    });
}

interface BranchRowOptions {
  treeId: string;
  /** 表示名。null は未解決（名前が取れなかった祖先）。 */
  label: string | null;
  depth: number;
  isOrigin: boolean;
  originDescriptor: string;
  params: BlockInspectorParams;
  /** ▸ 展開トグルを出すか（子を持つ下位ノード）。 */
  expandable: boolean;
}

/**
 * ブラウザ 1 行。表示の簡素化ルール:
 * - ルート文字（ドット無しかつ単一文字）: `M 人々の集団`
 * - 第1階層（ドット無し、例 M01）: `M01 名前`
 * - 第2階層以降（ドット有り）: 名前のみ（ID は title 属性へ退避）
 */
function buildBranchRow(doc: Document, opts: BranchRowOptions): HTMLElement {
  const { treeId, label, depth, isOrigin, originDescriptor, params } = opts;
  const row = doc.createElement('div');
  row.className = 'bins__row';
  if (isOrigin) {
    row.classList.add('bins__row--origin');
  }
  row.style.paddingLeft = `${depth * 16}px`;
  row.setAttribute('data-tree-id', treeId);

  const isCategoryRoot = !treeId.includes('.') && /^[A-Z]$/.test(treeId);
  const isFirstLevel = !treeId.includes('.') && !isCategoryRoot; // 例: M01

  // 展開トグル（▸/▾）。展開可能ノードのみ。
  const toggle = doc.createElement('button');
  toggle.type = 'button';
  toggle.className = 'bins__row-toggle';
  if (opts.expandable) {
    toggle.textContent = '▸';
    toggle.setAttribute('aria-label', '下位語を展開');
    toggle.addEventListener('click', () => toggleRow(doc, row, treeId, depth, originDescriptor, params, toggle));
  } else {
    // インデント揃えのためのプレースホルダ（カテゴリ root と第1階層・葉）。
    toggle.classList.add('bins__row-toggle--leaf');
    toggle.textContent = '';
    toggle.disabled = true;
  }
  row.appendChild(toggle);

  // ラベル（クリック＝置換）。カテゴリ root は MeSH 語ではないので非クリック。
  if (isCategoryRoot) {
    const cat = doc.createElement('span');
    cat.className = 'bins__row-cat';
    cat.textContent = `${treeId} ${meshCategoryName(treeId)}`;
    row.appendChild(cat);
    return row;
  }

  // 第1階層は ID を前置（`M01 名前`）。第2階層以降は ID を title に退避。
  if (isFirstLevel) {
    const idSpan = doc.createElement('span');
    idSpan.className = 'bins__row-id';
    idSpan.textContent = treeId;
    row.appendChild(idSpan);
  }

  const text = label ?? treeId; // 名前未解決時は ID で代替
  if (params.onApplyExpression && label !== null) {
    const link = doc.createElement('button');
    link.type = 'button';
    link.className = 'bins__row-name';
    link.textContent = text;
    link.title = `${treeId} ／ クリックでこの語に置換`;
    link.addEventListener('click', () => {
      params.onApplyExpression!(replaceMeshDescriptor(params.expression, originDescriptor, text));
    });
    row.appendChild(link);
  } else {
    const name = doc.createElement('span');
    name.className = 'bins__row-name bins__row-name--static';
    name.textContent = text;
    name.title = treeId;
    row.appendChild(name);
  }

  // 起点語には「起点」バッジ。
  if (isOrigin) {
    row.appendChild(badge(doc, '起点', 'bins__badge--origin'));
  }

  // 件数（explode）。
  if (params.onCountHits && label !== null) {
    row.appendChild(buildCountBadge(doc, meshHitQuery(text), params));
  }

  // OR追加（hover/focus で出す。起点語自身は既に式にあるので出さない）。
  if (params.onApplyExpression && label !== null && !hasMeshDescriptor(params.expression, text)) {
    const orBtn = doc.createElement('button');
    orBtn.type = 'button';
    orBtn.className = 'bins__row-or';
    orBtn.textContent = 'OR追加';
    orBtn.title = 'この語を別 OR 項としてブロックに足す';
    orBtn.addEventListener('click', () => {
      params.onApplyExpression!(addMeshDescriptor(params.expression, text));
    });
    row.appendChild(orBtn);
  }

  return row;
}

/** ▸/▾ トグル。展開状態を保持しつつ、直後の子受け皿（兄弟 div）を描く。 */
function toggleRow(
  doc: Document,
  row: HTMLElement,
  treeNumber: string,
  depth: number,
  originDescriptor: string,
  params: BlockInspectorParams,
  toggle: HTMLButtonElement
): void {
  const sub = row.nextElementSibling;
  if (!(sub instanceof HTMLElement) || !sub.classList.contains('bins__branch-children')) {
    return;
  }
  const expanded = expandedSetFor(params);
  if (expanded.has(treeNumber)) {
    // 折りたたむ。
    expanded.delete(treeNumber);
    sub.innerHTML = '';
    toggle.textContent = '▸';
    row.removeAttribute('data-expanded');
  } else {
    expanded.add(treeNumber);
    toggle.textContent = '▾';
    row.setAttribute('data-expanded', 'true');
    renderChildren(doc, sub, treeNumber, depth + 1, originDescriptor, params);
  }
}

/** 「同じ枝にまとまっている / N カテゴリに分散」の要約行。 */
function buildDivergenceLine(doc: Document, categories: readonly string[]): HTMLElement {
  const p = doc.createElement('p');
  p.className = 'bins__divergence';
  if (categories.length <= 1) {
    p.textContent = '↳ 同じ枝にまとまっています（ずれ小）。';
  } else {
    const named = categories.map((c) => `${c} ${meshCategoryName(c)}`).join(' / ');
    p.classList.add('bins__divergence--spread');
    p.textContent = `↳ ${categories.length} カテゴリに分散: ${named}（概念が広すぎないか確認）。`;
  }
  return p;
}

/** ブロック内 MeSH の冗長（祖先 explode 語に内包される語）を 1 行で示す。無ければ null。 */
function buildRedundancyLine(
  doc: Document,
  termMeta: ReadonlyMap<string, BlockMeshTermMeta>
): HTMLElement | null {
  const lines: string[] = [];
  for (const meta of termMeta.values()) {
    if (meta.subsumedBy.length > 0) {
      lines.push(`${meta.descriptor}（${meta.subsumedBy.join(', ')}配下）`);
    }
  }
  if (lines.length === 0) {
    return null;
  }
  const p = doc.createElement('p');
  p.className = 'bins__divergence bins__divergence--spread';
  p.textContent = `⚠ 冗長（内包）: ${lines.join(' / ')}`;
  return p;
}

/** フリーワード Δ をキャッシュ越しに計算する。キーは freewordCacheKey（同じ語集合なら計算を 1 回に抑える）。 */
function freewordDeltaCached(
  params: BlockInspectorParams,
  freewordTerms: FreewordTermInput[],
  onCountHits: NonNullable<BlockInspectorDeps['onCountHits']>
): Promise<FreewordDeltaResult> {
  const key = freewordCacheKey(freewordTerms);
  const cached = params.freewordDeltaCache.get(key);
  if (cached) {
    return cached;
  }
  const pending = analyzeFreewordDelta(freewordTerms, (q) =>
    cachedCount(onCountHits, params.hitsCache, q, params.hitsSnapshot)
  );
  params.freewordDeltaCache.set(key, pending);
  pending.then((result) => params.freewordDeltaSnapshot?.set(key, result));
  // 失敗は握りつぶさず、次回再試行できるようキャッシュから外す。
  pending.catch(() => params.freewordDeltaCache.delete(key));
  return pending;
}

// ---- フリーワード Δ セクション --------------------------------------------

function buildFreewordSection(
  doc: Document,
  freewordTerms: FreewordTermInput[],
  params: BlockInspectorParams
): HTMLElement {
  const wrap = doc.createElement('div');
  wrap.className = 'bins__section bins__freeword';
  const title = doc.createElement('p');
  title.className = 'bins__section-title';
  title.textContent = params.onApplyExpression
    ? 'フリーワード（個別ヒット数の多い順 / Δ=純増。語クリックで編集・× で削除）'
    : 'フリーワード（個別ヒット数の多い順 / Δ=累積に足したときの純増）';
  wrap.appendChild(title);

  if (freewordTerms.length === 0) {
    wrap.appendChild(muted(doc, 'この式にフリーワードはありません。'));
    return wrap;
  }

  const body = doc.createElement('div');
  body.className = 'bins__freeword-body';
  const loading = doc.createElement('p');
  loading.className = 'bins__loading';
  loading.textContent = '各語のヒット数と Δ を計算中…';
  body.appendChild(loading);
  wrap.appendChild(body);

  const onCountHits = params.onCountHits!;
  freewordDeltaCached(params, freewordTerms, onCountHits)
    .then((res) => {
      body.innerHTML = '';
      const maxDelta = res.rows.reduce((m, r) => Math.max(m, r.delta), 0);
      const table = doc.createElement('table');
      table.className = 'bins__delta-table';
      for (const row of res.rows) {
        table.appendChild(buildDeltaRow(doc, row, maxDelta, params));
      }
      body.appendChild(table);

      const total = doc.createElement('p');
      total.className = 'bins__delta-total';
      total.textContent = `tiab 合計（重複除去後）: ${res.totalDeduped.toLocaleString()} 件`;
      body.appendChild(total);
    })
    .catch((err: unknown) => {
      body.innerHTML = '';
      body.appendChild(muted(doc, `Δ の計算に失敗しました: ${formatError(err)}`));
    });

  return wrap;
}

/**
 * Δ 表の 1 行。語 / 個別 / Δ / 増分バー / ステータスバッジ / 操作（× 削除）。
 * onApplyExpression が注入されているときだけ、語クリックでのその場編集（タグ保持）と
 * × 削除を出す。チップ編集面と同じ純粋関数（setOperandTerm / removeOperandAt）を通すので、
 * 編集面とインスペクタのどちらから触っても同じ結果になる。
 */
function buildDeltaRow(
  doc: Document,
  row: FreewordDeltaRow,
  maxDelta: number,
  params: BlockInspectorParams
): HTMLElement {
  const tr = doc.createElement('tr');
  tr.className = `bins__delta-row bins__delta-row--${row.status}`;

  // 編集可能なときは row.query（タグ込み）から式上の operand を引き当てる。
  const operand = params.onApplyExpression ? findOperandByText(params.expression, row.query) : null;

  const termCell = doc.createElement('td');
  termCell.className = 'bins__delta-term draft__term draft__term--freeword';
  if (params.onApplyExpression && operand) {
    const termBtn = doc.createElement('button');
    termBtn.type = 'button';
    termBtn.className = 'bins__delta-term-btn';
    termBtn.textContent = row.display;
    termBtn.title = 'クリックで語を編集（タグは保持）';
    termBtn.addEventListener('click', () =>
      beginDeltaEdit(doc, termCell, termBtn, operand.term, (next) =>
        params.onApplyExpression!(setOperandTerm(params.expression, operand.index, next))
      )
    );
    termCell.appendChild(termBtn);
  } else {
    termCell.textContent = row.display;
  }
  tr.appendChild(termCell);

  const indCell = doc.createElement('td');
  indCell.className = 'bins__delta-individual';
  indCell.textContent = `${row.individual.toLocaleString()} 件`;
  tr.appendChild(indCell);

  const deltaCell = doc.createElement('td');
  deltaCell.className = 'bins__delta-value';
  deltaCell.textContent = `+${row.delta.toLocaleString()}`;
  tr.appendChild(deltaCell);

  const barCell = doc.createElement('td');
  barCell.className = 'bins__delta-barcell';
  const bar = doc.createElement('span');
  bar.className = 'bins__delta-bar';
  const pct = maxDelta > 0 ? Math.round((row.delta / maxDelta) * 100) : 0;
  bar.style.width = `${pct}%`;
  barCell.appendChild(bar);
  tr.appendChild(barCell);

  const flagCell = doc.createElement('td');
  flagCell.className = 'bins__delta-flag';
  if (row.zeroHit) {
    flagCell.textContent = '⚠ ヒット0（綴り/語形を確認）';
  } else if (row.status === 'redundant') {
    flagCell.textContent = '⚠ 他語に内包（削除候補）';
  } else if (row.status === 'lowYield') {
    flagCell.textContent = '△ ほぼ寄与なし';
  }
  tr.appendChild(flagCell);

  // 操作（× 削除）。編集可能で operand を引き当てられたときだけ。
  const actionCell = doc.createElement('td');
  actionCell.className = 'bins__delta-actions';
  if (params.onApplyExpression && operand) {
    const removeBtn = doc.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'bins__delta-remove';
    removeBtn.textContent = '×';
    removeBtn.title = 'この語を削除';
    removeBtn.setAttribute('aria-label', `「${row.display}」を削除`);
    removeBtn.addEventListener('click', () =>
      params.onApplyExpression!(removeOperandAt(params.expression, operand.index))
    );
    actionCell.appendChild(removeBtn);
  }
  tr.appendChild(actionCell);

  return tr;
}

/** Δ 表の語セルを、語だけ編集する <input> に差し替える（Enter/blur 確定、Esc 取消）。 */
function beginDeltaEdit(
  doc: Document,
  cell: HTMLElement,
  termBtn: HTMLButtonElement,
  initialTerm: string,
  onCommit: (next: string) => void
): void {
  const input = doc.createElement('input');
  input.type = 'text';
  input.className = 'bins__delta-input';
  input.value = initialTerm;
  input.setAttribute('aria-label', `「${initialTerm}」を編集`);

  let done = false;
  const commit = (): void => {
    if (done) {
      return;
    }
    done = true;
    const next = input.value.trim();
    if (next === initialTerm.trim()) {
      input.replaceWith(termBtn);
      return;
    }
    onCommit(next);
  };
  const cancel = (): void => {
    if (done) {
      return;
    }
    done = true;
    input.replaceWith(termBtn);
  };
  input.addEventListener('keydown', (ev: KeyboardEvent) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      commit();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      cancel();
    }
  });
  input.addEventListener('blur', () => commit());

  cell.replaceChildren(input);
  input.focus();
  input.select();
}

// ---- 他ブロックとの重複セクション ------------------------------------------

function buildOverlapSection(
  doc: Document,
  params: BlockInspectorParams,
  terms: ParsedBlockTerms
): HTMLElement {
  const wrap = doc.createElement('div');
  wrap.className = 'bins__section bins__overlap';

  // 表示は従来どおり「共有語がある兄弟だけ」に絞る（computeSiblingOverlapsFromTerms 自体は
  // AI へ渡す都合上、共有語 0 件の兄弟も含めて返すため、ここで絞り込む）。
  // terms は buildBlockInspector が params.expression を既に解析済みのものを受け取り、
  // ここで extractBlockTerms を再度走らせない（issue #92 C-6）。
  const overlaps = computeSiblingOverlapsFromTerms(terms, params.siblings).filter(
    (o) => o.sharedTerms.length > 0
  );

  const errorLine = doc.createElement('p');
  errorLine.className = 'bins__overlap-error';
  errorLine.setAttribute('aria-live', 'polite');

  if (overlaps.length === 0) {
    wrap.appendChild(muted(doc, '他ブロックと重複する語はありません。'));
    wrap.appendChild(errorLine);
    return wrap;
  }

  for (const overlap of overlaps) {
    const p = doc.createElement('p');
    p.className = 'bins__overlap-line';
    const label = overlap.label ? ` ${overlap.label}` : '';
    p.appendChild(doc.createTextNode(`⚠ #${overlap.id}${label} と共有: `));
    overlap.sharedTerms.forEach((shared, idx) => {
      if (idx > 0) {
        p.appendChild(doc.createTextNode(', '));
      }
      p.appendChild(buildOverlapTerm(doc, shared, errorLine, params));
    });
    wrap.appendChild(p);
  }
  wrap.appendChild(errorLine);
  return wrap;
}

/**
 * 重複行 1 語ぶんの表示。onApplyExpression が注入されているときだけ「削除」ボタンを添える
 * （issue #89。手作業でその場で消せる、AI を使わない道）。
 * MeSH descriptor は removeMeshDescriptor、フリーワードは findOperandByText で operand を
 * 引き当てて removeOperandAt に委譲する（editView のチップ編集・インスペクタの他セクションと
 * 同じ純粋関数を経由するので、どこから触っても同じ結果になる）。
 *
 * MeSH かフリーワードかは shared.kind をそのまま使い、この関数では再判定しない
 * （issue #92 B-5）。`myMesh.has(term)`（自分の式に同名の MeSH descriptor があるか）で
 * 再判定する書き方も考えられるが、それは「タグ無しの語をどちらの集合にも入れない」という
 * extractBlockTerms / tokenizeExpression の現在の挙動に暗黙に依存する（MeSH descriptor は
 * 括弧なしの文字列、フリーワード query は `[tag]` 込みの文字列なので、現状は両者の文字列
 * 空間が交わらず取り違えは起きない）。この前提が変わる（例: タグ無しの語をフリーワードとして
 * 拾うようになる）と、同一ブロック内に同名の MeSH descriptor とタグ無しフリーワードが
 * 両方あるケース（例: `"Asthma"[Mesh] OR Asthma OR wheez*[tiab]`）で取り違えが起きうる。
 * kind は computeSiblingOverlaps が共有語を見つけた時点（myMesh 側の一致か myFree 側の
 * 一致か）で確定しているため、そちらを持ち回るほうがこの前提に依存せず安全。
 */
function buildOverlapTerm(
  doc: Document,
  shared: SharedTerm,
  errorLine: HTMLElement,
  params: BlockInspectorParams
): HTMLElement {
  const span = doc.createElement('span');
  span.className = 'bins__overlap-term';
  span.appendChild(doc.createTextNode(shared.term));

  if (params.onApplyExpression) {
    const removeBtn = doc.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'bins__overlap-remove';
    removeBtn.textContent = '削除';
    removeBtn.title = `"${shared.term}" をこのブロックから外す`;
    removeBtn.setAttribute('aria-label', `「${shared.term}」をこのブロックから削除`);
    removeBtn.addEventListener('click', () => {
      errorLine.textContent = '';
      const next =
        shared.kind === 'mesh'
          ? removeMeshDescriptor(params.expression, shared.term)
          : removeOperandByQuery(params.expression, shared.term);
      if (next === null) {
        // フリーワード query が式上の operand と引き当てられない（見つからない）場合は何もしない。
        return;
      }
      params.onApplyExpression!(next, (msg) => {
        errorLine.textContent = msg;
      });
    });
    span.appendChild(removeBtn);
  }
  return span;
}

/** フリーワード query（タグ込み）を式上の operand へ引き当てて削除する。見つからなければ null。 */
function removeOperandByQuery(expression: string, query: string): string | null {
  const operand = findOperandByText(expression, query);
  if (!operand) {
    return null;
  }
  return removeOperandAt(expression, operand.index);
}

// ---- 共通ヘルパー ---------------------------------------------------------

/**
 * 「…」→件数 に差し替わる小さな件数バッジ。
 *
 * MeSH ブラウザは枝＋子ノードで行数が多くなりやすいので、件数の esearch は **その行が
 * 表示範囲に入ったとき**（IntersectionObserver）にだけ走らせる。スクロールで初めて見える
 * 下位ノードの件数を、開いた瞬間に全行ぶん一気に取りに行かないようにするための遅延。
 * IntersectionObserver が無い環境（jsdom 等）では即時取得にフォールバックする。
 */
function buildCountBadge(
  doc: Document,
  query: string,
  params: BlockInspectorParams
): HTMLElement {
  const onCountHits = params.onCountHits!;
  const badgeEl = doc.createElement('span');
  badgeEl.className = 'bins__count bins__count--pending';
  badgeEl.textContent = '…';
  observeInView(badgeEl, () => {
    cachedCount(onCountHits, params.hitsCache, query, params.hitsSnapshot)
      .then((count) => {
        badgeEl.className = 'bins__count bins__count--done';
        badgeEl.textContent = `${count.toLocaleString()} 件`;
      })
      .catch(() => {
        badgeEl.className = 'bins__count bins__count--error';
        badgeEl.textContent = '件数エラー';
      });
  });
  return badgeEl;
}

/**
 * 要素が初めて表示範囲に入ったら一度だけ onEnter を呼ぶ（その後 observer は破棄）。
 * IntersectionObserver が使えない環境（jsdom 等）では遅延せず即時に onEnter を呼ぶ。
 */
function observeInView(el: HTMLElement, onEnter: () => void): void {
  const view = el.ownerDocument.defaultView;
  const IO = view?.IntersectionObserver;
  if (!IO) {
    onEnter();
    return;
  }
  const observer = new IO((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) {
      observer.disconnect();
      onEnter();
    }
  });
  observer.observe(el);
}

function badge(doc: Document, text: string, className: string): HTMLElement {
  const el = doc.createElement('span');
  el.className = `bins__badge ${className}`;
  el.textContent = text;
  return el;
}

function muted(doc: Document, text: string): HTMLElement {
  const p = doc.createElement('p');
  p.className = 'bins__muted';
  p.textContent = text;
  return p;
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
