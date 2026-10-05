import { parsePubmedFormulaMd, type PubmedFormula } from '../../../src/lib/search-formula-md';
import { expandFormula } from '../../../src/features/validation/expandFormula';

export function validateFormulaMd(md: string): { ok: true; query: string; formula: PubmedFormula } | { ok: false; reasons: string[] } {
  let formula: PubmedFormula;
  try { formula = parsePubmedFormulaMd(md); }
  catch (error) { return { ok: false, reasons: [String(error)] }; }
  const reasons: string[] = [];
  if (!formula.blocks.length) reasons.push('ブロックがありません');
  const ids = new Set(formula.blocks.map((block) => block.id));
  for (const { id, expression } of formula.blocks) {
    let quoted = false;
    let depth = 0;
    let balanced = true;
    for (const char of expression) {
      if (char === '"') quoted = !quoted;
      if (!quoted && char === '(') depth++;
      if (!quoted && char === ')' && --depth < 0) balanced = false;
    }
    if (quoted) reasons.push(`#${id}: 引用符が対応していません`);
    if (!balanced || depth !== 0) reasons.push(`#${id}: 括弧が対応していません`);
    for (const ref of expression.matchAll(/#([A-Za-z0-9]+)/g)) if (!ids.has(ref[1]!)) reasons.push(`#${id}: 未定義の参照 #${ref[1]}`);
    try { if (!expandFormula(formula, id).trim()) reasons.push(`#${id}: 展開後の式が空です`); }
    catch (error) { reasons.push(String(error)); }
  }
  let query = '';
  try { query = expandFormula(formula); } catch { /* 各行の検査で理由を記録済み。 */ }
  if (!query.trim()) reasons.push('展開後の式が空です');
  return reasons.length ? { ok: false, reasons } : { ok: true, query, formula };
}
