/**
 * Cochrane Embase RCT 感度フィルタの Dialog/Embase 版。
 * PubMed 検索式中の `"randomized controlled trial"[pt]` 等の RCT 出版タイプフィルタを
 * 本フィルタで代替する。
 *
 * 出典: Cochrane Handbook Chapter 4, Section 4.4.7
 * https://www.cochrane.org/authors/handbooks-and-manuals/handbook/current/chapter-04#section-4-4-7
 *
 * 2026-11 に利用者から受け取った更新版（S1〜S35 の 35 行）をそのまま保持する。
 * 旧版は 1 行に畳んだ式で、近接距離（NEAR/1 など）や S2 の Emtree 語
 * （controlled clinical trial）に誤りがあった。
 */

/**
 * PubMed 式の RCT 出版タイプフィルタを検出する正規表現。
 * `"Randomized Controlled Trial"[pt]` / `randomized controlled trial[pt]` のどちらにも一致する。
 */
export const PUBMED_RCT_PT_REGEX =
  /(?:"randomized\s+controlled\s+trial"|randomized\s+controlled\s+trial)\s*\[pt\]/i;

/**
 * フィルタ本体。要素 i（0 始まり）がフィルタ内の `S{i+1}` に当たり、
 * 行内の `S<n>` はフィルタ内の行を指す。検索式へ埋め込むときは
 * {@link renumberDialogRctFilter} で前後の行と重ならない番号へずらす。
 * 最終行（S35 = S20 NOT S34）がフィルタの結果になる。
 */
export const DIALOG_RCT_FILTER_LINES: readonly string[] = [
  'EMB.EXACT.EXPLODE("randomized controlled trial")',
  'EMB.EXACT.EXPLODE("controlled clinical study")',
  'TI(random*) OR AB(random*)',
  'EMB.EXACT.EXACT("randomization")',
  'EMB.EXACT.EXACT("intermethod comparison")',
  'TI(placebo) OR AB(placebo)',
  'TI(compare OR compared OR comparison)',
  'AB(evaluated OR evaluate OR evaluating OR assessed OR assess) AND AB(compare OR compared OR comparing OR comparison)',
  'TI("open label") OR AB("open label")',
  'TI((double OR single OR doubly OR singly) NEAR/0 (blind OR blinded OR blindly)) OR AB((double OR single OR doubly OR singly) NEAR/0 (blind OR blinded OR blindly))',
  'EMB.EXACT.EXACT("double blind procedure")',
  'TI(parallel NEAR/0 group*) OR AB(parallel NEAR/0 group*)',
  'TI(crossover OR "cross over") OR AB(crossover OR "cross over")',
  'TI((assign* OR match OR matched OR allocation) NEAR/4 (alternate OR group OR groups OR intervention OR interventions OR patient OR patients OR subject OR subjects OR participant OR participants)) OR AB((assign* OR match OR matched OR allocation) NEAR/4 (alternate OR group OR groups OR intervention OR interventions OR patient OR patients OR subject OR subjects OR participant OR participants))',
  'TI(assigned OR allocated) OR AB(assigned OR allocated)',
  'TI(controlled NEAR/6 (study OR design OR trial)) OR AB(controlled NEAR/6 (study OR design OR trial))',
  'TI(volunteer OR volunteers) OR AB(volunteer OR volunteers)',
  'EMB.EXACT.EXACT("human experiment")',
  'TI(trial)',
  'S1 OR S2 OR S3 OR S4 OR S5 OR S6 OR S7 OR S8 OR S9 OR S10 OR S11 OR S12 OR S13 OR S14 OR S15 OR S16 OR S17 OR S18 OR S19',
  '(TI((random* PRE/0 sampl*) NEAR/6 ("cross section*" OR questionnaire* OR survey OR surveys OR database OR databases)) OR AB((random* PRE/0 sampl*) NEAR/6 ("cross section*" OR questionnaire* OR survey OR surveys OR database OR databases))) NOT (EMB.EXACT.EXPLODE("comparative study") OR EMB.EXACT.EXPLODE("controlled study") OR TI("randomised controlled" OR "randomized controlled" OR "randomly assigned") OR AB("randomised controlled" OR "randomized controlled" OR "randomly assigned"))',
  'EMB.EXACT.EXACT("cross-sectional study") NOT (EMB.EXACT.EXPLODE("randomized controlled trial") OR EMB.EXACT.EXACT("controlled clinical study") OR EMB.EXACT.EXACT("controlled study") OR TI("randomised controlled" OR "randomized controlled" OR "control group" OR "control groups") OR AB("randomised controlled" OR "randomized controlled" OR "control group" OR "control groups"))',
  '((TI("case control*") OR AB("case control*")) AND (TI(random*) OR AB(random*))) NOT (TI("randomised controlled" OR "randomized controlled") OR AB("randomised controlled" OR "randomized controlled"))',
  'TI("systematic review") NOT TI(trial OR study)',
  '(TI(nonrandom*) OR AB(nonrandom*)) NOT (TI(random*) OR AB(random*))',
  'TI("random field*") OR AB("random field*")',
  'TI("random cluster" NEAR/2 sampl*) OR AB("random cluster" NEAR/2 sampl*)',
  '(AB(review) AND RTYPE(review)) NOT TI(trial)',
  'AB("we searched") AND (TI(review) OR RTYPE(review))',
  'AB("update review")',
  'AB(databases NEAR/3 searched)',
  'TI(rat OR rats OR mouse OR mice OR swine OR porcine OR murine OR sheep OR lambs OR pigs OR piglets OR rabbit OR rabbits OR cat OR cats OR dog OR dogs OR cattle OR bovine OR monkey OR monkeys OR trout OR marmoset*) AND EMB.EXACT.EXACT("animal experiment")',
  'EMB.EXACT.EXACT("animal experiment") NOT (EMB.EXACT.EXACT("human experiment") OR EMB.EXACT.EXACT("human"))',
  'S21 OR S22 OR S23 OR S24 OR S25 OR S26 OR S27 OR S28 OR S29 OR S30 OR S31 OR S32 OR S33',
  'S20 NOT S34',
];

/**
 * フィルタ内の行参照 `S<n>` を、検索式中の開始番号 `startNumber` に合わせてずらす。
 * 戻り値の要素 i は検索式上の `S{startNumber + i}` の式になる。
 */
export function renumberDialogRctFilter(startNumber: number): string[] {
  const offset = startNumber - 1;
  return DIALOG_RCT_FILTER_LINES.map((line) =>
    line.replace(/\bS(\d+)\b/g, (_m, n: string) => `S${Number(n) + offset}`)
  );
}
