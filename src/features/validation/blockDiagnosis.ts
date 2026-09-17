import type { PubmedFormula } from '@/lib/search-formula-md';
import { tokenizeCombination } from '@/lib/combination-expression/parse';
import { extractMeshTerm, tokenizeExpression } from '@/lib/search-formula-md/expression';
import { isExplodeTag } from './blockTerms';
import { expandFormula } from './expandFormula';
import { hasPrecedenceMixing, PRECEDENCE_MIXING_DIAGNOSIS_NOTE } from './precedenceMixing';

// 凍結 C0 43 本・判定できた 100 ブロックの削減率分布で校正した値（issue #164）。分布の下側に
// ある最も広い切れ目は 9.8%〜17.0%（幅 7.2pt。次に広い切れ目の 1.6 倍）で、その中点 13.4% に
// 最も近い丸めがこの 0.13。切れ目の上側 17.0〜17.3% には 4 ブロックが密集しているため、初期値
// だった 0.2 はこの密集の中を通っていて、僅かな件数差で判定が反転していた。
// 下げる方向が安全側である理由: 誤検出したブロックは blockDiagnosisLines 経由で AI に
// 「絞り込みに効いていない」と伝わって実際は効いているブロックを狭めさせ、さらに
// diagnosedHeldBlock 経由で diagnosed_block_held の早期停止を招く。取りこぼしは助言が
// 出ないだけで済む。測り直す手順は experiments/query-optimization-bench/README.md の
// 「ブロック診断だけの評価」を参照。
export const BLOCK_NARROWING_MIN_REDUCTION = 0.13;
export const MAX_DIAGNOSIS_API_CALLS = 30;
export const DIAGNOSIS_LIMIT_NOTE = '未判定: 診断の通信上限（30 回）に達した';
export const DIAGNOSIS_CHANGED_NOTE = '未判定: 式の変更後に再測定していない';

export interface MeshOccurrence {
  descriptor: string;
  text: string;
  explode: boolean;
  negative: boolean;
  qualified: boolean;
}
export interface BlockOverlap {
  blockIds: [string, string];
  kind: 'same' | 'ancestor' | 'unknown';
  terms: { blockId: string; text: string }[];
  qualified: boolean;
  note: string;
}
export interface BlockNarrowing {
  blockId: string;
  label: string;
  finalHits: number | null;
  withoutHits: number | null;
  reduction: number | null;
  ineffective: boolean | null;
  note: string;
}
export interface BlockPrecedenceMixing {
  blockId: string;
  label: string;
  note: string;
}
export interface BlockDiagnosis {
  fingerprint: string;
  overlaps: BlockOverlap[];
  narrowing: BlockNarrowing[];
  note: string;
  /** 括弧の無い AND/NOT と OR が同じ括弧グループ（括弧で囲まれていない同じ並び）に混在している
   * 承認済み概念ブロック（issue #202）。旧形式のチェックポイント・監査記録には存在しないため
   * 任意項目とし、無ければ空扱いにする。 */
  precedence?: BlockPrecedenceMixing[];
}

/** 出現単位でタグと NOT 側の位置を保持する。NOT 直後の括弧は全体を除外側にする。 */
export function meshOccurrences(expression: string): MeshOccurrence[] {
  const result: MeshOccurrence[] = [];
  const negativeGroups: boolean[] = [];
  let negative = false;
  for (const segment of tokenizeExpression(expression)) {
    if (segment.kind === 'plain') {
      for (const token of segment.text.match(/\b(?:AND|OR|NOT)\b|[()]/gi) ?? []) {
        if (token === '(') { negativeGroups.push(negative || negativeGroups.includes(true)); negative = false; }
        else if (token === ')') { negativeGroups.pop(); negative = false; }
        else negative = token.toUpperCase() === 'NOT';
      }
    } else {
      if (segment.kind === 'mesh') {
        const extracted = extractMeshTerm(segment.text);
        result.push({ descriptor: extracted.split('/')[0]!.trim(), text: segment.text,
          explode: isExplodeTag(segment.text), negative: negative || negativeGroups.includes(true),
          qualified: extracted.includes('/') || /\[(?:majr|mesh major topic)(?::[^\]]*)?\]/i.test(segment.text) });
      }
      negative = false;
    }
  }
  return result;
}

export function diagnosisTargets(formula: PubmedFormula, approved: readonly { id: string; label: string }[]) {
  const combination = [...formula.blocks].reverse().find((block) => block.isCombination);
  const { tokens, errors } = tokenizeCombination(combination?.expression ?? '');
  const simple = !!combination && !errors.length && tokens.length % 2 === 1
    && tokens.every((token, index) => index % 2 === 0 ? token.kind === 'ref'
      && formula.blocks.some((block) => block.id === token.id && !block.isCombination)
      : token.kind === 'op' && token.op === 'AND');
  const refs = simple ? tokens.flatMap((token) => token.kind === 'ref' ? [token.id] : []) : [];
  const blocks = approved.flatMap((block) => {
    const source = formula.blocks.find((item) => item.id === block.id && !item.isCombination);
    return refs.includes(block.id) && source ? [{ ...source, label: block.label }] : [];
  });
  return { simple, refs, blocks, combination };
}

/** 対象の参照だけを外し、承認外の固定ブロックも同じ式内に残す。 */
export function queryWithoutBlock(formula: PubmedFormula, refs: readonly string[], blockId: string): string | null {
  const remaining = refs.filter((id) => id !== blockId);
  if (!remaining.length) return null;
  return remaining.map((id) => `(${expandFormula(formula, id)})`).join(' AND ');
}

export function diagnoseStructure(formula: PubmedFormula, approved: readonly { id: string; label: string }[],
  trees: ReadonlyMap<string, readonly string[]>, reasons: ReadonlyMap<string, string> = new Map()): Pick<BlockDiagnosis, 'overlaps' | 'note'> {
  const { simple, blocks } = diagnosisTargets(formula, approved);
  if (!simple) return { overlaps: [], note: '未判定: 結合式が単純な AND ではない' };
  const overlaps: BlockOverlap[] = [];
  const descendant = (child: readonly string[], parent: readonly string[]) => child.some((c) => parent.some((p) => c.startsWith(`${p}.`)));
  for (let i = 0; i < blocks.length; i += 1) {
    const x = blocks[i]!;
    for (const y of blocks.slice(i + 1)) {
      const xs = meshOccurrences(x.expression).filter((term) => !term.negative);
      const ys = meshOccurrences(y.expression).filter((term) => !term.negative);
      const unknowns = new Set<MeshOccurrence>();
      for (const a of xs) {
        for (const b of ys) {
          const at = trees.get(a.descriptor.toLowerCase()) ?? [];
          const bt = trees.get(b.descriptor.toLowerCase()) ?? [];
          const same = a.descriptor.toLowerCase() === b.descriptor.toLowerCase();
          const parent = a.explode && descendant(bt, at) ? [x.id, a.text, y.id, b.text]
            : b.explode && descendant(at, bt) ? [y.id, b.text, x.id, a.text] : null;
          if (!same && !parent) {
            if (!at.length) unknowns.add(a);
            if (!bt.length) unknowns.add(b);
            continue;
          }
          const kind = same ? 'same' : 'ancestor';
          const note = same ? `#${x.id} と #${y.id}: 同じ MeSH ${a.text} / ${b.text}`
            : `#${parent![0]} の ${parent![1]} は #${parent![2]} の ${parent![3]} の上位語`;
          overlaps.push({ blockIds: [x.id, y.id], kind, terms: [{ blockId: x.id, text: a.text }, { blockId: y.id, text: b.text }],
            qualified: a.qualified || b.qualified, note });
        }
      }
      if (unknowns.size) {
        const occurrences = [...xs.map((term) => ({ blockId: x.id, term })), ...ys.map((term) => ({ blockId: y.id, term }))]
          .filter(({ term }) => unknowns.has(term));
        const details = occurrences.slice(0, 10).map(({ term }) => `${term.text}: ${reasons.get(term.descriptor.toLowerCase()) ?? '階層不明'}`);
        if (occurrences.length > 10) details.push(`ほか ${occurrences.length - 10} 件`);
        overlaps.push({ blockIds: [x.id, y.id], kind: 'unknown',
          terms: occurrences.map(({ blockId, term }) => ({ blockId, text: term.text })),
          qualified: occurrences.some(({ term }) => term.qualified),
          note: `#${x.id} と #${y.id}: 未判定: 階層を取得できなかった（${details.join('、')}）` });
      }
    }
  }
  return { overlaps, note: '' };
}

/**
 * 承認済み概念ブロックのうち、括弧の無い AND/NOT と OR が同じ括弧グループ（括弧で囲まれていない
 * 同じ並び）に混在しているものを診断する。
 * diagnoseStructure と異なり、最終結合式が単純な AND であるかどうかには依存しない
 * （優先順位の混在はブロック単体の式だけで判定できるため）。
 */
export function diagnosePrecedenceMixing(formula: PubmedFormula,
  approved: readonly { id: string; label: string }[]): BlockPrecedenceMixing[] {
  return approved.flatMap((approvedBlock) => {
    const block = formula.blocks.find((item) => item.id === approvedBlock.id && !item.isCombination);
    if (!block || !hasPrecedenceMixing(block.expression)) return [];
    return [{ blockId: block.id, label: approvedBlock.label,
      note: `#${block.id} ${approvedBlock.label}: ${PRECEDENCE_MIXING_DIAGNOSIS_NOTE}` }];
  });
}

export function diagnoseNarrowing(block: { id: string; label: string }, finalHits: number | null,
  withoutHits: number | null, failure = ''): BlockNarrowing {
  const note = failure || (finalHits === null ? '未判定: 最終式の件数が不明'
    : withoutHits === null ? '未判定: ブロックを外した式を測定できなかった'
      : withoutHits === 0 ? '未判定: ブロックを外した式が 0 件'
        : withoutHits < finalHits ? '未判定: ブロックを外した式が最終式より少ない' : '');
  const reduction = note ? null : (withoutHits! - finalHits!) / withoutHits!;
  return { blockId: block.id, label: block.label, finalHits, withoutHits, reduction,
    ineffective: reduction === null ? null : reduction < BLOCK_NARROWING_MIN_REDUCTION, note };
}

export function blockDiagnosisLines(diagnosis: BlockDiagnosis): string[] {
  return [ ...(diagnosis.note ? [diagnosis.note] : []),
    ...(diagnosis.precedence ?? []).map((row) => row.note),
    ...diagnosis.overlaps.map((row) => row.note + (row.qualified ? '（修飾付き）' : '')),
    ...diagnosis.narrowing.map((row) => row.reduction === null ? `#${row.blockId} ${row.label}: ${row.note}`
      : `#${row.blockId} ${row.label}: 外すと ${row.withoutHits!.toLocaleString('en-US')} 件 → 最終式 ${row.finalHits!.toLocaleString('en-US')} 件（削減率 ${(row.reduction * 100).toFixed(1)}%）${row.ineffective ? ' 絞り込みに効いていない' : ''}`) ];
}
