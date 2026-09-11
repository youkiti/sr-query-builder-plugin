/** 検索式の語と、計測済みの寄与・共有語を組み立てる。 */
import { extractMeshTerm, tokenizeExpression } from '@/lib/search-formula-md/expression';
import type { FreewordTermInput, FreewordDeltaResult, FreewordDeltaStatus } from './freewordDelta';

/** 解決済みの測定値だけを同期的に読むための入力。 */
export interface MeasuredSnapshots {
  hitsSnapshot?: ReadonlyMap<string, number>;
  freewordDeltaSnapshot?: ReadonlyMap<string, FreewordDeltaResult>;
}

/** 他ブロックとの重複判定に使う兄弟ブロック。 */
export interface SiblingBlock {
  id: string;
  label: string | null;
  expression: string;
}


/** ブロック式から抽出した MeSH 用語（descriptor + explode 可否）。 */
export interface ParsedMeshTerm {
  descriptor: string;
  explode: boolean;
}

export interface ParsedBlockTerms {
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
export function isExplodeTag(segmentText: string): boolean {
  const tag = segmentText.match(/\[([^\]]+)\]\s*$/)?.[1] ?? '';
  return !/:\s*noexp/i.test(tag);
}

/** インスペクタが計測したキーワード 1 語ぶんのヒット数（issue #58 chunk 3c）。 */
export interface MeasuredKeywordHit {
  term: string;
  kind: 'mesh' | 'freeword';
  /** 単体 esearch ヒット数。未計測なら null */
  hits: number | null;
  /** フリーワードのみ: 個別降順で OR 累積したときの純増（Δ）。MeSH・未計測は null */
  delta?: number | null;
  /** フリーワードのみ: 寄与区分。MeSH・未計測は null */
  status?: FreewordDeltaStatus | null;
}

/** collectMeasuredContext の戻り値（issue #58 chunk 3c）。 */
export interface MeasuredBlockContext {
  keywordHits: MeasuredKeywordHit[];
  /** フリーワード OR 合計（重複除去後）。フリーワードが未計測なら null */
  freewordDedupTotal: number | null;
}

/**
 * インスペクタがこれまでに計測した値を、新規 NCBI リクエストを一切発行せずに同期的に取り出す
 * （issue #58 chunk 3c。「AI に改善させる」実行時に improve-block skill へ渡す文脈を組み立てる用途）。
 *
 * hitsSnapshot / freewordDeltaSnapshot（cachedCount / freewordDeltaCached が解決のたびに書き込む、
 * hitsCache / freewordDeltaCache の確定値スナップショット）だけを読む。値が無い（インスペクタ未展開・
 * MeSH バッジがまだ表示範囲に入っていない・Δ 計算が未解決、等）語は結果に含めない —
 * 「計測できていない」を憶測で埋めないため。
 *
 * - MeSH 語: このブロックの descriptor と完全一致する `"descriptor"[Mesh]` の計測値のみ拾う
 *   （祖先・子孫ノードのバッジ計測は対象外）。
 * - フリーワード: このブロックのフリーワード集合と完全一致する Δ 計算結果が解決済みのときだけ、
 *   行ごとの個別ヒット数・Δ・寄与区分と、OR 合計（freewordDedupTotal）をまとめて返す。
 *   一部の語だけ計測済みでも、集合が一致しなければ（Δ 計算が式全体を単位にしているため）拾わない。
 */
export function collectMeasuredContext(
  expression: string,
  snapshots: MeasuredSnapshots
): MeasuredBlockContext {
  const terms = extractBlockTerms(expression);
  const keywordHits: MeasuredKeywordHit[] = [];

  for (const meshTerm of terms.meshTerms) {
    const hits = snapshots.hitsSnapshot?.get(meshHitQuery(meshTerm.descriptor));
    if (hits !== undefined) {
      keywordHits.push({ term: meshTerm.descriptor, kind: 'mesh', hits });
    }
  }

  let freewordDedupTotal: number | null = null;
  if (terms.freewordTerms.length > 0) {
    const delta = snapshots.freewordDeltaSnapshot?.get(freewordCacheKey(terms.freewordTerms));
    if (delta) {
      freewordDedupTotal = delta.totalDeduped;
      for (const row of delta.rows) {
        keywordHits.push({
          term: row.display,
          kind: 'freeword',
          hits: row.individualError ? null : row.individual,
          delta: row.individualError ? null : row.delta,
          status: row.individualError ? null : row.status,
        });
      }
    }
  }

  return { keywordHits, freewordDedupTotal };
}


/**
 * tree number を「カテゴリ文字 → 各階層 → 自分」の順に並べる。
 * 例: `M01.526.485` → `['M', 'M01', 'M01.526', 'M01.526.485']`。
 * 先頭のカテゴリ文字（`M`）は buildMeshHierarchy と同様に独立ノードとして足す。
 */
export function spineTreeNumbers(treeNumber: string): string[] {
  const parts = treeNumber.split('.');
  const head = parts[0] ?? '';
  const category = head.charAt(0);
  const out: string[] = category !== '' ? [category] : [];
  let acc = '';
  for (let i = 0; i < parts.length; i += 1) {
    acc = i === 0 ? parts[i]! : `${acc}.${parts[i]!}`;
    out.push(acc);
  }
  return out;
}


/**
 * フリーワード語集合から freewordDeltaCache / freewordDeltaSnapshot 共通のキーを作る。
 * analyzeFreewordDelta は内部で個別件数の降順に並べ替えるので、入力順は結果に影響しない。
 * よって順不同で安定なキー（query をソートして連結）にする。区切り文字は U+0001
 * （検索式の query には現れない想定）。
 */
export function freewordCacheKey(terms: readonly FreewordTermInput[]): string {
  return terms
    .map((t) => t.query)
    .sort()
    .join('\u0001');
}


/**
 * 兄弟ブロックとの共有語 1 件（issue #92 B-5）。
 * term だけでなく、それが computeSiblingOverlaps 側で MeSH descriptor として一致したのか
 * フリーワード query として一致したのかを kind として持つ。
 *
 * term の文字列だけから種別を再判定する（例: `myMesh.has(term)` で「自分の式に同名の
 * MeSH descriptor があるか」を見る）のではなく、computeSiblingOverlaps が共有語を
 * 見つけた時点（myMesh 側の一致で見つけたか myFree 側の一致で見つけたか）で種別を確定させ、
 * それをそのまま持ち回る設計にしている。
 *
 * 現行の tokenizeExpression / extractBlockTerms はタグ無しの語をどちらの集合にも
 * 入れない（`[tag]` が付いた segment だけを mesh/freeword に分類し、タグ無しの裸の語は
 * 'plain' として捨てる）ため、MeSH descriptor の文字列（括弧なし）とフリーワード query
 * の文字列（`[tag]` 込み）は現状では衝突しない。つまり term ベースの再判定でも今は
 * 取り違えは起きない。ただしこれは extractBlockTerms の現在の挙動への暗黙の依存であり、
 * 将来タグ無しの語をフリーワードとして拾うようになる等でこの前提が崩れると、同名の
 * MeSH descriptor とフリーワードが式内に共存するケースで取り違えが起きうる。kind を
 * 計算時点で確定させて持ち回る設計はこの前提に依存しないため、より安全な側を採る。
 */
export interface SharedTerm {
  term: string;
  kind: 'mesh' | 'freeword';
}

/** 兄弟ブロック 1 件について、自分の式と共有している語（issue #89）。 */
export interface SiblingOverlap {
  id: string;
  label: string | null;
  expression: string;
  /** 自分と共有している語（表示順は MeSH → フリーワード。kind で種別を明示する。issue #92 B-5） */
  sharedTerms: SharedTerm[];
}

/**
 * 自分の式と兄弟ブロックそれぞれとの共有語を計算する（issue #89）。
 * buildOverlapSection（表示）と、AI 改善へ渡す文脈（editView.ts の openAiPromptForm）の
 * 双方が同じ計算を共有するための純関数。
 *
 * **兄弟ブロックは共有語の有無にかかわらず全件返す**（sharedTerms は空配列になりうる）。
 * 共有語の判定は MeSH descriptor / フリーワード query の完全一致のみで、
 * タグ違い（`[tiab]` vs `[tw]`）・単複（child/children）・MeSH とフリーワードの対応
 * （`"Asthma"[Mesh]` vs `asthma[tiab]`）のような「完全一致しない重複」は検出できない。
 * これらを 0 件（＝重複なし）として黙って除外すると、AI へは何も渡らず、根拠の無い
 * 推測での過剰削除が再発する（issue #89 の元テスター報告は完全一致とは限らない）。
 * そのため呼び出し側（AI へ渡す文脈）は「兄弟が 1 件でもあれば渡す」を基準にし、
 * 共有語が 0 件かどうかは付加情報として渡す。表示側（buildOverlapSection）だけが
 * 「共有 0 件の兄弟は行を出さない」というこれまでの UI 方針でフィルタする。
 */
export function computeSiblingOverlaps(
  expression: string,
  siblings: readonly SiblingBlock[]
): SiblingOverlap[] {
  return computeSiblingOverlapsFromTerms(extractBlockTerms(expression), siblings);
}

/**
 * computeSiblingOverlaps の本体。自分の式の解析結果（ParsedBlockTerms）を直接受け取る版
 * （issue #92 C-6）。buildBlockInspector は自分の式を extractBlockTerms(params.expression)
 * で既に 1 度解析済みなので、buildOverlapSection からはこちらを呼び、
 * computeSiblingOverlaps(expression, ...) 経由の再解析（インスペクタ再描画のたびに発生）を
 * 避ける。editView.ts（openAiPromptForm）は式の文字列しか持たないため、従来どおり
 * computeSiblingOverlaps(expression, siblings) を呼ぶ（シグネチャは変えない）。
 */
export function computeSiblingOverlapsFromTerms(
  terms: ParsedBlockTerms,
  siblings: readonly SiblingBlock[]
): SiblingOverlap[] {
  const myMesh = new Set(terms.meshTerms.map((t) => t.descriptor));
  const myFree = new Set(terms.freewordTerms.map((t) => t.query));

  return siblings.map((sib) => {
    const sibTerms = extractBlockTerms(sib.expression);
    const sharedMesh: SharedTerm[] = sibTerms.meshTerms
      .map((t) => t.descriptor)
      .filter((d) => myMesh.has(d))
      .map((term) => ({ term, kind: 'mesh' as const }));
    const sharedFree: SharedTerm[] = sibTerms.freewordTerms
      .map((t) => t.query)
      .filter((q) => myFree.has(q))
      .map((term) => ({ term, kind: 'freeword' as const }));
    return {
      id: sib.id,
      label: sib.label,
      expression: sib.expression,
      sharedTerms: [...sharedMesh, ...sharedFree],
    };
  });
}


/** MeSH ラベルの explode 件数を問う esearch クエリ。バッジ表示と collectMeasuredContext で共有する。 */
export function meshHitQuery(label: string): string {
  return `"${label}"[Mesh]`;
}

