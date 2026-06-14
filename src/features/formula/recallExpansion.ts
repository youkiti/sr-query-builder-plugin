import type { PubmedFormula } from '@/lib/search-formula-md';

/**
 * 検索式の「外側（margin）」を探索するための recall 拡張ロジック（純粋関数）。
 *
 * #/expand の対話的 seed 拡張は、当初は **現検索式のヒット集合の中** から境界事例を
 * 選んでいた。しかしそれでは「式の中の論文を式で検証する」だけになり、include しても
 * 捕捉率は構造的に 100% のまま（トートロジー）で、検索式を見直す材料にならなかった。
 *
 * そこでこのモジュールは、現検索式を 2 軸（MeSH を一段広く / フリーワード追加）で
 * 緩めた「拡張式」を組み立て、`拡張式 NOT 現式` の **差集合（margin）= 式の外側** から
 * 境界事例を拾えるようにする。include されたのに現式が捕まえていない論文が出れば、
 * それは検索式の取りこぼし（recall ギャップ）であり、どの拡張語が拾えたかを集計して
 * 「ブロック #N にこの語を足すと M 件回収できる」という更新提案に落とす。
 *
 * 本モジュールは NCBI / LLM に依存しない純粋ロジックだけを持つ。実際の esearch / efetch /
 * LLM 呼び出しは expandService が行い、その入力（拡張語）と出力（include 判定された論文）を
 * ここへ渡す。
 */

/** 拡張の軸。`mesh` = MeSH を一段広く、`freeword` = ti/ab フリーワード追加。 */
export type RecallAxis = 'mesh' | 'freeword';

/** 1 ブロックに OR で足す 1 つの拡張語。 */
export interface RecallAdditionItem {
  /** PubMed クエリ片（例: `"Heart Diseases"[Mesh]` / `"cardioprotect*"[tiab]`）。 */
  term: string;
  axis: RecallAxis;
  /** なぜこの語で広げるか（日本語、1-2 文）。 */
  rationale: string;
}

/** ブロックごとの拡張語束。blockId は現検索式の `#N` の N。 */
export interface BlockRecallAdditions {
  blockId: string;
  additions: RecallAdditionItem[];
}

/** include 判定された論文（更新提案の集計対象）。efetch 由来のメタを使う。 */
export interface IncludedPaper {
  pmid: string;
  title: string | null;
  abstract: string | null;
  meshHeadings: string[];
}

/** 更新提案 1 行ぶん（ある拡張語が何件の include 論文を回収したか）。 */
export interface ProposalTerm {
  term: string;
  axis: RecallAxis;
  rationale: string;
  /** この語が（推定で）回収した include 論文の PMID。 */
  recoveredPmids: string[];
}

/** 1 ブロックに対する検索式更新提案。 */
export interface UpdateProposal {
  blockId: string;
  /** 回収数の多い順に並べた拡張語。 */
  terms: ProposalTerm[];
  /** このブロックの提案語いずれかが回収した PMID の和集合。 */
  recoveredPmids: string[];
}

/**
 * 現検索式に拡張語を OR で織り込んだ「拡張式」を組み立てる。
 *
 * - 結合行（isCombination）と、他ブロックを参照する行は広げない（AND 構造は保つ）。
 * - 概念ブロックは `(元の式) OR 追加1 OR 追加2 ...` に置き換える。各ブロックの集合が
 *   広がるだけなので、AND 結合後も結果は必ず現式の上位集合（superset）になる。
 * - 追加語が無いブロックはそのまま。
 *
 * combinationExpression は変更しない（参照名は不変）。
 */
export function buildBroadenedFormula(
  formula: PubmedFormula,
  additions: readonly BlockRecallAdditions[]
): PubmedFormula {
  const blockIds = new Set(formula.blocks.map((b) => b.id));
  const byBlock = new Map(additions.map((a) => [a.blockId, a.additions]));
  const blocks = formula.blocks.map((block) => {
    if (block.isCombination) return block;
    if (referencesOtherBlock(block.expression, block.id, blockIds)) return block;
    const adds = byBlock.get(block.id) ?? [];
    const terms = adds.map((a) => a.term.trim()).filter((t) => t !== '');
    if (terms.length === 0) return block;
    return { ...block, expression: `(${block.expression}) OR ${terms.join(' OR ')}` };
  });
  return { blocks, combinationExpression: formula.combinationExpression };
}

/** 式の外側（margin）クエリ: 拡張式に当たって現式に当たらない論文だけを取る。 */
export function buildMarginQuery(broadenedQuery: string, originalQuery: string): string {
  return `(${broadenedQuery.trim()}) NOT (${originalQuery.trim()})`;
}

/** 拡張語に blockId を添えて平坦化する。 */
export function flattenAdditions(
  additions: readonly BlockRecallAdditions[]
): Array<RecallAdditionItem & { blockId: string }> {
  const out: Array<RecallAdditionItem & { blockId: string }> = [];
  for (const block of additions) {
    for (const item of block.additions) {
      out.push({ ...item, blockId: block.blockId });
    }
  }
  return out;
}

/**
 * include 判定された論文と拡張語から、検索式更新提案を組み立てる。
 *
 * margin から拾った論文は定義上「現式の外側」なので、include されたものはすべて
 * 現式の取りこぼし。各論文を「どの拡張語が拾えたか」でローカル照合（タイトル/抄録の
 * 部分一致 / MeSH 見出しの一致）し、回収件数の多い語からブロック単位の提案にまとめる。
 *
 * 照合はローカル近似（MeSH の explode 関係までは見ない）。提案は「推定」として扱う。
 */
export function buildUpdateProposals(
  includedPapers: readonly IncludedPaper[],
  additions: readonly BlockRecallAdditions[]
): UpdateProposal[] {
  const flat = flattenAdditions(additions);
  const byBlock = new Map<string, ProposalTerm[]>();

  for (const item of flat) {
    const recoveredPmids = includedPapers
      .filter((paper) => matchAdditionToPaper(item, paper))
      .map((paper) => paper.pmid);
    if (recoveredPmids.length === 0) continue;
    const list = byBlock.get(item.blockId) ?? [];
    list.push({
      term: item.term,
      axis: item.axis,
      rationale: item.rationale,
      recoveredPmids,
    });
    byBlock.set(item.blockId, list);
  }

  const proposals: UpdateProposal[] = [];
  for (const [blockId, terms] of byBlock.entries()) {
    terms.sort((a, b) => b.recoveredPmids.length - a.recoveredPmids.length);
    const union = new Set<string>();
    for (const term of terms) {
      for (const pmid of term.recoveredPmids) union.add(pmid);
    }
    proposals.push({ blockId, terms, recoveredPmids: Array.from(union) });
  }
  proposals.sort((a, b) => b.recoveredPmids.length - a.recoveredPmids.length);
  return proposals;
}

/**
 * 拡張語が論文を（推定で）拾うかをローカル照合する。
 * - freeword: フィールドタグ・引用符・末尾ワイルドカードを剥がした語をタイトル+抄録に部分一致
 * - mesh: 同様に剥がした descriptor を論文の MeSH 見出しと（双方向の部分一致で）照合
 */
export function matchAdditionToPaper(
  item: Pick<RecallAdditionItem, 'term' | 'axis'>,
  paper: IncludedPaper
): boolean {
  const needle = extractNeedle(item.term);
  if (needle.length < 2) return false;
  if (item.axis === 'freeword') {
    const haystack = `${paper.title ?? ''} ${paper.abstract ?? ''}`.toLowerCase();
    return haystack.includes(needle);
  }
  return paper.meshHeadings.some((heading) => {
    const h = heading.trim().toLowerCase();
    if (h.length < 2) return false;
    return h === needle || h.includes(needle) || needle.includes(h);
  });
}

/** `"Heart Diseases"[Mesh]` → `heart diseases`、`word*[tiab]` → `word` 等に正規化。 */
function extractNeedle(term: string): string {
  let s = term.trim();
  // 末尾のフィールドタグ [..] を除去
  s = s.replace(/\[[^\]]*\]\s*$/, '').trim();
  // 周囲の引用符を除去
  s = s.replace(/^["']|["']$/g, '').trim();
  // 末尾ワイルドカードを除去
  s = s.replace(/\*+$/, '').trim();
  return s.toLowerCase();
}

/** 式中に自分以外の既存ブロック ID への参照（`#N`）が含まれるか。 */
function referencesOtherBlock(
  expression: string,
  selfId: string,
  blockIds: ReadonlySet<string>
): boolean {
  const matches = expression.matchAll(/#([A-Za-z0-9]+)/g);
  for (const m of matches) {
    const ref = m[1]!;
    if (ref !== selfId && blockIds.has(ref)) return true;
  }
  return false;
}
