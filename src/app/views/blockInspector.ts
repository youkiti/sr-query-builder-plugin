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
 *
 * 計測は注入された `onCountHits`（esearch count）と `onFetchMeshTrees`（db=mesh tree number）に
 * 委譲し、結果は edit view から渡されるキャッシュで使い回す（同一式の重複 esearch を防ぐ）。
 */

import {
  analyzeFreewordDelta,
  buildBlockMeshTree,
  meshCategoryName,
  type BlockMeshTermInput,
  type BlockMeshTermMeta,
  type FreewordDeltaRow,
  type FreewordTermInput,
  type MeshHierarchyNode,
  type MeshTreeEntry,
} from '@/features/validation';
import type { MeshTreeNode } from '@/lib/ncbi';
import { extractMeshTerm, tokenizeExpression } from './formulaDisplay';
import { addMeshDescriptor, hasMeshDescriptor, removeMeshDescriptor } from './meshExpressionEdit';

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
   * MeSH ブラウザからの追加・削除でブロック式を差し替える。注入された場合のみ
   * ナビに「＋ブロックに追加」「−削除」ボタンを出す。引数は当該ブロックの新しい式全文。
   */
  onApplyExpression?: (nextExpression: string) => void;
  /** 式→件数キャッシュ（edit view インスタンスと共有） */
  hitsCache: Map<string, Promise<number>>;
  /** descriptor 群→tree entries キャッシュ（edit view インスタンスと共有） */
  meshTreeCache: Map<string, Promise<MeshTreeEntry[]>>;
  /** tree number→子ノード キャッシュ（edit view インスタンスと共有） */
  meshChildrenCache: Map<string, Promise<MeshTreeNode[]>>;
  /** tree number 群→ラベル Map キャッシュ（edit view インスタンスと共有） */
  meshLabelCache: Map<string, Promise<Map<string, MeshTreeNode>>>;
}

/** 他ブロックとの重複判定に使う兄弟ブロック。 */
export interface SiblingBlock {
  id: string;
  label: string | null;
  expression: string;
}

export interface BlockInspectorParams extends BlockInspectorDeps {
  blockId: string;
  expression: string;
  /** 自分以外の概念ブロック（結合行は含めない） */
  siblings: SiblingBlock[];
}

/** ブロック式から抽出した MeSH 用語（descriptor + explode 可否）。 */
interface ParsedMeshTerm {
  descriptor: string;
  explode: boolean;
}

interface ParsedBlockTerms {
  meshTerms: ParsedMeshTerm[];
  freewordTerms: FreewordTermInput[];
}

/**
 * 式を MeSH 用語 / フリーワード語に分解する。
 * - MeSH: descriptor と explode 可否（`[Mesh]`/`[mh]`=explode, `:noexp` 付き=非 explode）
 * - フリーワード: タグ込みのテキストをそのまま query にする
 * MeSH は descriptor で、フリーワードは query で重複除去する（explode はどちらかが true なら true）。
 */
export function extractBlockTerms(expression: string): ParsedBlockTerms {
  const meshByDescriptor = new Map<string, ParsedMeshTerm>();
  const freewordByQuery = new Map<string, FreewordTermInput>();
  for (const segment of tokenizeExpression(expression)) {
    if (segment.kind === 'mesh') {
      const descriptor = extractMeshTerm(segment.text);
      if (descriptor === '') {
        continue;
      }
      const explode = isExplodeTag(segment.text);
      const existing = meshByDescriptor.get(descriptor);
      if (existing) {
        existing.explode = existing.explode || explode;
      } else {
        meshByDescriptor.set(descriptor, { descriptor, explode });
      }
    } else if (segment.kind === 'freeword') {
      const query = segment.text.trim();
      if (query !== '' && !freewordByQuery.has(query)) {
        freewordByQuery.set(query, { display: query, query });
      }
    }
  }
  return {
    meshTerms: Array.from(meshByDescriptor.values()),
    freewordTerms: Array.from(freewordByQuery.values()),
  };
}

/** MeSH セグメント末尾のタグから explode 可否を判定する（`:noexp` が無ければ explode）。 */
function isExplodeTag(segmentText: string): boolean {
  const tag = segmentText.match(/\[([^\]]+)\]\s*$/)?.[1] ?? '';
  return !/:\s*noexp/i.test(tag);
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
  section.appendChild(buildOverlapSection(doc, terms, params.siblings));

  return section;
}

/** 式→件数のキャッシュ越し count。 */
function cachedCount(
  onCountHits: NonNullable<BlockInspectorDeps['onCountHits']>,
  cache: Map<string, Promise<number>>,
  query: string
): Promise<number> {
  const cached = cache.get(query);
  if (cached) {
    return cached;
  }
  const pending = onCountHits(query);
  cache.set(query, pending);
  pending.catch(() => cache.delete(query));
  return pending;
}

// ---- MeSH ツリーセクション ------------------------------------------------

function buildMeshSection(
  doc: Document,
  meshTerms: ParsedMeshTerm[],
  params: BlockInspectorParams
): HTMLElement {
  const wrap = doc.createElement('div');
  wrap.className = 'bins__section bins__mesh';
  const title = doc.createElement('p');
  title.className = 'bins__section-title';
  title.textContent = 'MeSH（この枝にどう乗っているか）';
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

  const descriptors = meshTerms.map((t) => t.descriptor);
  fetchMeshTreesCached(params, descriptors)
    .then((entries) => {
      const treeByDescriptor = new Map(entries.map((e) => [e.descriptor, e.treeNumbers]));
      const inputs: BlockMeshTermInput[] = meshTerms.map((t) => ({
        descriptor: t.descriptor,
        explode: t.explode,
        treeNumbers: treeByDescriptor.get(t.descriptor) ?? [],
      }));
      const result = buildBlockMeshTree(inputs);
      body.innerHTML = '';
      // 祖先（構造）ノードの名前を後から埋めるための treeId→<span> 受け皿。
      const ancestorNameSpans = new Map<string, HTMLElement>();
      body.appendChild(buildMeshTreeDom(doc, result.nodes, result.termMeta, params, ancestorNameSpans));
      body.appendChild(buildDivergenceLine(doc, result.categories));
      // ① 祖先ノードの名前を MeSH RDF からバッチ逆引きして埋める（PubMed 風の名前表示）。
      fillAncestorNames(params, ancestorNameSpans);
      // ②③ 各 MeSH 用語に「下位語ブラウザ（ナビ + 追加/削除）」を付ける。
      if (params.onFetchMeshChildren) {
        for (const term of meshTerms) {
          const treeNumbers = treeByDescriptor.get(term.descriptor) ?? [];
          for (const treeNumber of treeNumbers) {
            body.appendChild(buildMeshNavigator(doc, term.descriptor, treeNumber, params));
          }
        }
      }
      if (result.unresolved.length > 0) {
        body.appendChild(
          muted(doc, `ツリー未解決（MeSH 解決不可）: ${result.unresolved.join(', ')}`)
        );
      }
    })
    .catch((err: unknown) => {
      body.innerHTML = '';
      body.appendChild(muted(doc, `MeSH 階層の取得に失敗しました: ${formatError(err)}`));
    });

  return wrap;
}

/** 構造ノード（名前未取得の祖先）の tree number 群を MeSH RDF で解決し、span を埋める。 */
function fillAncestorNames(
  params: BlockInspectorParams,
  nameSpans: Map<string, HTMLElement>
): void {
  if (!params.onFetchMeshLabels || nameSpans.size === 0) {
    return;
  }
  const treeNumbers = Array.from(nameSpans.keys());
  fetchMeshLabelsCached(params, treeNumbers)
    .then((labelByTree) => {
      for (const [treeId, span] of nameSpans) {
        const node = labelByTree.get(treeId);
        if (node) {
          span.textContent = node.label;
        }
      }
    })
    .catch(() => {
      // 名前が取れなくても tree id は残るので致命ではない。何もしない。
    });
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

/** 階層ノード（flat + parentId）をネストした <ul> に組み立てる。 */
function buildMeshTreeDom(
  doc: Document,
  nodes: readonly MeshHierarchyNode[],
  termMeta: ReadonlyMap<string, BlockMeshTermMeta>,
  params: BlockInspectorParams,
  ancestorNameSpans: Map<string, HTMLElement>
): HTMLElement {
  const childrenByParent = new Map<string | null, MeshHierarchyNode[]>();
  for (const node of nodes) {
    const list = childrenByParent.get(node.parentId);
    if (list) {
      list.push(node);
    } else {
      childrenByParent.set(node.parentId, [node]);
    }
  }

  const renderLevel = (parentId: string | null): HTMLElement | null => {
    const children = childrenByParent.get(parentId);
    if (!children || children.length === 0) {
      return null;
    }
    const ul = doc.createElement('ul');
    ul.className = 'bins__tree';
    for (const node of children) {
      const li = doc.createElement('li');
      li.className = 'bins__tree-node';
      li.appendChild(buildTreeNodeLine(doc, node, termMeta, parentId === null, params, ancestorNameSpans));
      const sub = renderLevel(node.treeId);
      if (sub) {
        li.appendChild(sub);
      }
      ul.appendChild(li);
    }
    return ul;
  };

  return renderLevel(null) ?? doc.createElement('ul');
}

/** ツリー 1 ノードの行（tree id + 名前 + descriptor + バッジ + 件数）。 */
function buildTreeNodeLine(
  doc: Document,
  node: MeshHierarchyNode,
  termMeta: ReadonlyMap<string, BlockMeshTermMeta>,
  isRoot: boolean,
  params: BlockInspectorParams,
  ancestorNameSpans: Map<string, HTMLElement>
): HTMLElement {
  const line = doc.createElement('div');
  line.className = 'bins__tree-line';

  const idSpan = doc.createElement('span');
  idSpan.className = 'bins__tree-id';
  idSpan.textContent = isRoot ? `${node.treeId} ${meshCategoryName(node.treeId)}` : node.treeId;
  line.appendChild(idSpan);

  if (node.labels.length === 0) {
    // 構造ノード（祖先）。tree id の隣に名前用の span を置き、後で MeSH RDF で埋める。
    line.classList.add('bins__tree-line--structural');
    if (params.onFetchMeshLabels && !isRoot) {
      const nameSpan = doc.createElement('span');
      nameSpan.className = 'bins__tree-name';
      line.appendChild(nameSpan);
      ancestorNameSpans.set(node.treeId, nameSpan);
    }
    return line;
  }

  for (const descriptor of node.labels) {
    const meta = termMeta.get(descriptor);
    const termSpan = doc.createElement('span');
    termSpan.className = 'bins__tree-term';
    termSpan.textContent = descriptor;
    line.appendChild(termSpan);

    if (meta?.explode) {
      line.appendChild(badge(doc, 'explode', 'bins__badge--explode'));
    }
    if (meta && meta.subsumedBy.length > 0) {
      line.appendChild(
        badge(doc, `⚠ 重複（${meta.subsumedBy.join(', ')}配下）`, 'bins__badge--redundant')
      );
    }
    // 個別ヒット数（onCountHits があれば）
    if (params.onCountHits) {
      const query = meta?.explode === false ? `"${descriptor}"[Mesh:NoExp]` : `"${descriptor}"[Mesh]`;
      line.appendChild(buildCountBadge(doc, query, params));
    }
  }

  return line;
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

// ---- MeSH ブラウザ（下位語ナビ + 追加/削除）-------------------------------

/** ナビの「現在地」。tree number と表示ラベルを持つ。 */
interface NavLocation {
  treeNumber: string;
  label: string;
}

/**
 * 1 つの MeSH 用語を起点に、ツリーを上下に辿れるミニブラウザを作る（②）。
 * 「現在地」を上に出し、その子（1 段下）を名前＋件数で並べる。子の「↓ 下りる」で
 * 現在地を 1 段下げ、件数がどう変わるかをライブ表示する。onApplyExpression があれば
 * 「＋ブロックに追加」「−削除」も出す（③）。
 */
function buildMeshNavigator(
  doc: Document,
  descriptor: string,
  startTreeNumber: string,
  params: BlockInspectorParams
): HTMLElement {
  const wrap = doc.createElement('details');
  wrap.className = 'bins__nav';
  const summary = doc.createElement('summary');
  summary.className = 'bins__nav-summary';
  summary.textContent = `▸ 「${descriptor}」の下位語をブラウズ（${startTreeNumber}）`;
  wrap.appendChild(summary);

  const body = doc.createElement('div');
  body.className = 'bins__nav-body';
  wrap.appendChild(body);

  const start: NavLocation = { treeNumber: startTreeNumber, label: descriptor };
  // 初回展開時にだけ描画する（無駄な fetch を避ける）。
  let rendered = false;
  wrap.addEventListener('toggle', () => {
    if (wrap.open && !rendered) {
      rendered = true;
      renderNavBody(doc, body, start, start, params);
    }
  });
  return wrap;
}

/**
 * ナビ本体を「現在地 + 子リスト」で描き直す。current が起点(start)でなければ
 * 「↑ 親へ」も出す。すべて body 内のローカル再描画（全体再描画は起こさない）。
 */
function renderNavBody(
  doc: Document,
  body: HTMLElement,
  current: NavLocation,
  start: NavLocation,
  params: BlockInspectorParams
): void {
  body.innerHTML = '';

  // 現在地
  const currentRow = doc.createElement('div');
  currentRow.className = 'bins__nav-current';
  const here = doc.createElement('span');
  here.className = 'bins__nav-here';
  here.textContent = `現在地: ${current.label}`;
  currentRow.appendChild(here);
  const tn = doc.createElement('span');
  tn.className = 'bins__nav-tn';
  tn.textContent = current.treeNumber;
  currentRow.appendChild(tn);
  if (params.onCountHits) {
    currentRow.appendChild(buildCountBadge(doc, `"${current.label}"[Mesh]`, params));
  }
  appendApplyButtons(doc, currentRow, current.label, params);
  body.appendChild(currentRow);

  // ナビ操作行（親へ戻る）
  const nav = doc.createElement('div');
  nav.className = 'bins__nav-controls';
  const parentTn = parentTreeNumber(current.treeNumber);
  if (parentTn && current.treeNumber !== start.treeNumber) {
    const upBtn = doc.createElement('button');
    upBtn.type = 'button';
    upBtn.className = 'bins__nav-up';
    upBtn.textContent = '↑ 親へ戻る';
    upBtn.addEventListener('click', () => {
      navigateTo(doc, body, parentTn, start, params);
    });
    nav.appendChild(upBtn);
  }
  body.appendChild(nav);

  // 子リスト
  const childWrap = doc.createElement('div');
  childWrap.className = 'bins__nav-children';
  const loading = doc.createElement('p');
  loading.className = 'bins__loading';
  loading.textContent = '下位語を取得中…';
  childWrap.appendChild(loading);
  body.appendChild(childWrap);

  fetchMeshChildrenCached(params, current.treeNumber)
    .then((children) => {
      childWrap.innerHTML = '';
      if (children.length === 0) {
        childWrap.appendChild(muted(doc, 'これより下位の MeSH 用語はありません（最下層）。'));
        return;
      }
      const heading = doc.createElement('p');
      heading.className = 'bins__nav-children-title';
      heading.textContent = `下位語（${children.length}）`;
      childWrap.appendChild(heading);
      for (const child of children) {
        childWrap.appendChild(buildNavChildRow(doc, body, child, start, params));
      }
    })
    .catch((err: unknown) => {
      childWrap.innerHTML = '';
      childWrap.appendChild(muted(doc, `下位語の取得に失敗しました: ${formatError(err)}`));
    });
}

/** 子ノード 1 行（名前 + 件数 + ↓下りる + ＋追加）。 */
function buildNavChildRow(
  doc: Document,
  body: HTMLElement,
  child: MeshTreeNode,
  start: NavLocation,
  params: BlockInspectorParams
): HTMLElement {
  const row = doc.createElement('div');
  row.className = 'bins__nav-child';

  const label = doc.createElement('span');
  label.className = 'bins__nav-child-label';
  label.textContent = child.label;
  row.appendChild(label);

  if (params.onCountHits) {
    row.appendChild(buildCountBadge(doc, `"${child.label}"[Mesh]`, params));
  }

  const downBtn = doc.createElement('button');
  downBtn.type = 'button';
  downBtn.className = 'bins__nav-down';
  downBtn.textContent = '↓ 下りる';
  downBtn.title = `${child.label} を現在地にして、さらに下位語を見る`;
  downBtn.addEventListener('click', () => {
    navigateTo(doc, body, child.treeNumber, start, params, child.label);
  });
  row.appendChild(downBtn);

  appendApplyButtons(doc, row, child.label, params);
  return row;
}

/** 「＋ブロックに追加」/「−削除」ボタンを行へ足す（onApplyExpression 注入時のみ）。 */
function appendApplyButtons(
  doc: Document,
  row: HTMLElement,
  label: string,
  params: BlockInspectorParams
): void {
  const onApply = params.onApplyExpression;
  if (!onApply) {
    return;
  }
  if (hasMeshDescriptor(params.expression, label)) {
    const removeBtn = doc.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'bins__nav-remove';
    removeBtn.textContent = '− ブロックから削除';
    removeBtn.addEventListener('click', () => {
      const next = removeMeshDescriptor(params.expression, label);
      if (next.trim() === '') {
        // 唯一の語を消すと式が空になるので拒否（ブロックは空にできない）。
        removeBtn.disabled = true;
        removeBtn.textContent = '− 削除不可（最後の語）';
        return;
      }
      onApply(next);
    });
    row.appendChild(removeBtn);
  } else {
    const addBtn = doc.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'bins__nav-add';
    addBtn.textContent = '＋ ブロックに追加';
    addBtn.addEventListener('click', () => {
      onApply(addMeshDescriptor(params.expression, label));
    });
    row.appendChild(addBtn);
  }
}

/** 指定 tree number へ現在地を移す。label 未指定なら MeSH RDF で名前を引いてから描く。 */
function navigateTo(
  doc: Document,
  body: HTMLElement,
  treeNumber: string,
  start: NavLocation,
  params: BlockInspectorParams,
  label?: string
): void {
  if (label !== undefined) {
    renderNavBody(doc, body, { treeNumber, label }, start, params);
    return;
  }
  // 親へ戻るときは名前が手元に無いので逆引きしてから描く。
  if (params.onFetchMeshLabels) {
    fetchMeshLabelsCached(params, [treeNumber])
      .then((labelByTree) => {
        const node = labelByTree.get(treeNumber);
        renderNavBody(doc, body, { treeNumber, label: node?.label ?? treeNumber }, start, params);
      })
      .catch(() => {
        renderNavBody(doc, body, { treeNumber, label: treeNumber }, start, params);
      });
  } else {
    renderNavBody(doc, body, { treeNumber, label: treeNumber }, start, params);
  }
}

/** tree number の親（末尾 `.NNN` を 1 つ落とす）。カテゴリ直下や不正なら null。 */
function parentTreeNumber(treeNumber: string): string | null {
  const idx = treeNumber.lastIndexOf('.');
  return idx > 0 ? treeNumber.slice(0, idx) : null;
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
  title.textContent = 'フリーワード（個別ヒット数の多い順 / Δ=累積に足したときの純増）';
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
  analyzeFreewordDelta(freewordTerms, (q) => cachedCount(onCountHits, params.hitsCache, q))
    .then((res) => {
      body.innerHTML = '';
      const maxDelta = res.rows.reduce((m, r) => Math.max(m, r.delta), 0);
      const table = doc.createElement('table');
      table.className = 'bins__delta-table';
      for (const row of res.rows) {
        table.appendChild(buildDeltaRow(doc, row, maxDelta));
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

/** Δ 表の 1 行。語 / 個別 / Δ / 増分バー / ステータスバッジ。 */
function buildDeltaRow(doc: Document, row: FreewordDeltaRow, maxDelta: number): HTMLElement {
  const tr = doc.createElement('tr');
  tr.className = `bins__delta-row bins__delta-row--${row.status}`;

  const termCell = doc.createElement('td');
  termCell.className = 'bins__delta-term draft__term draft__term--freeword';
  termCell.textContent = row.display;
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

  return tr;
}

// ---- 他ブロックとの重複セクション ------------------------------------------

function buildOverlapSection(
  doc: Document,
  terms: ParsedBlockTerms,
  siblings: readonly SiblingBlock[]
): HTMLElement {
  const wrap = doc.createElement('div');
  wrap.className = 'bins__section bins__overlap';

  const myMesh = new Set(terms.meshTerms.map((t) => t.descriptor));
  const myFree = new Set(terms.freewordTerms.map((t) => t.query));

  const lines: HTMLElement[] = [];
  for (const sib of siblings) {
    const sibTerms = extractBlockTerms(sib.expression);
    const sharedMesh = sibTerms.meshTerms.map((t) => t.descriptor).filter((d) => myMesh.has(d));
    const sharedFree = sibTerms.freewordTerms.map((t) => t.query).filter((q) => myFree.has(q));
    const shared = [...sharedMesh, ...sharedFree];
    if (shared.length > 0) {
      const p = doc.createElement('p');
      p.className = 'bins__overlap-line';
      const label = sib.label ? ` ${sib.label}` : '';
      p.textContent = `⚠ #${sib.id}${label} と共有: ${shared.join(', ')}`;
      lines.push(p);
    }
  }

  if (lines.length === 0) {
    wrap.appendChild(muted(doc, '他ブロックと重複する語はありません。'));
  } else {
    for (const line of lines) {
      wrap.appendChild(line);
    }
  }
  return wrap;
}

// ---- 共通ヘルパー ---------------------------------------------------------

/** 「計測中…」→件数 に差し替わる小さな件数バッジ。 */
function buildCountBadge(
  doc: Document,
  query: string,
  params: BlockInspectorParams
): HTMLElement {
  const onCountHits = params.onCountHits!;
  const badgeEl = doc.createElement('span');
  badgeEl.className = 'bins__count bins__count--pending';
  badgeEl.textContent = '…';
  cachedCount(onCountHits, params.hitsCache, query)
    .then((count) => {
      badgeEl.className = 'bins__count bins__count--done';
      badgeEl.textContent = `${count.toLocaleString()} 件`;
    })
    .catch(() => {
      badgeEl.className = 'bins__count bins__count--error';
      badgeEl.textContent = '件数エラー';
    });
  return badgeEl;
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
