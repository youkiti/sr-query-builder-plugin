/**
 * PubMed の既知フィールドタグ一覧と、それらを丸ごと除去するユーティリティ。
 *
 * ClinicalTrials.gov / ICTRP は PubMed のフィールドタグ（`[Mesh]` `[tiab]` 等）を
 * 理解しないため、変換時にタグを丸ごと削除している。旧実装は
 * `[A-Za-z][A-Za-z0-9:_ -]*` という汎用文字クラスでブラケット内を丸ごと剥がしており、
 * 空白・ハイフンを許容する分だけ「タグらしい見た目だが実在しないタグ名」の
 * ブラケット表記まで無警告で削除しうる過剰マッチがあった（issue #60 3-5）。
 *
 * その修正としてホワイトリスト方式に変更したが、ホワイトリストの網羅が
 * 不十分だと今度は逆に「実在するが未登録のタグ」が無警告で出力へ残ってしまう
 * （消しすぎ→消さなすぎ、という別の「静かに間違う」経路になる）。
 * そのため本モジュールは 2 段構えにしてある:
 *
 * 1. {@link stripKnownPubmedFieldTags} — 実在が確認できているタグは積極的に除去する
 *    （レジストリがそのまま解釈できる文字列にするため）。
 * 2. {@link detectResidualFieldTagBrackets} — 除去後もなお残る `[...]` を検出する。
 *    PubMed 検索式の文法上、角括弧はフィールドタグ以外の用途に使われないため、
 *    既知タグ除去後に残る `[...]` は「ホワイトリストに無い＝取りこぼした」タグと
 *    みなしてよい。呼び出し側（toClinicalTrials.ts / toIctrp.ts）はこれを
 *    `ConversionResult.warnings` に積み、目視で気づける状態にする。
 *
 * タグ名の一覧は以下を突き合わせて作成した:
 * - search-formula-developper/scripts/conversion/generate_all_database_search.py の
 *   `clean_for_registry`（`Mesh|MeSH|MeSH Terms|mh|tiab|ti|ab|tw|Title/Abstract|Title|Affiliation|ad`）
 * - 本リポジトリの `residualPubmedTags.ts` が認識しているタグ
 *   （`pt` / `sh` / `mh` / `majr` / `la` / `dp` / `Date - Publication`）
 * - search-formula-developper/scripts/conversion/ovid/converter.py の `FIELD_MAP`
 *   （`au` / `ta` / `nm` / `rn` / `ot` 等、Ovid → PubMed 変換で実際に使われている PubMed タグ）
 * - search-formula-developper/tests/test_ovid_to_pubmed.py の実例（`mh:noexp` / `majr:noexp` 等）
 * - NCBI E-utilities / PubMed の公開フィールドタグ一覧（`sb`=Subset、`pdat`=Date - Publication、
 *   `All Fields`、`Text Word`、`Supplementary Concept` 等、SR の検索式で実際によく使われるもの）
 */
const KNOWN_FIELD_TAG_NAMES = [
  // MeSH 系
  'MeSH Major Topic',
  'MeSH Subheading',
  'MeSH Terms',
  'MeSH',
  'Mesh',
  'mh',
  'majr',
  'sh',
  'Supplementary Concept',
  'nm',
  // タイトル / アブストラクト / 本文
  'Title/Abstract',
  'Title',
  'tiab',
  'ti',
  'ab',
  'Text Word',
  'tw',
  'Other Term',
  'ot',
  'All Fields',
  // 出版・書誌情報
  'Publication Type',
  'pt',
  'Journal',
  'ta',
  'Language',
  'la',
  'Issue',
  'ip',
  'Volume',
  'vi',
  'Pagination',
  'pg',
  'ISBN',
  'isbn',
  'ISSN',
  'is',
  'Place of Publication',
  'pl',
  'Publisher',
  'pubn',
  'Location ID',
  'lid',
  // 著者・所属・投稿者
  'Affiliation',
  'ad',
  'Author',
  'au',
  'Author Identifier',
  'auid',
  'Full Author Name',
  'fau',
  'Corporate Author',
  'cn',
  'Editor',
  'ed',
  'Investigator',
  'in',
  'Full Investigator Name',
  'fir',
  'Personal Name as Subject',
  'ps',
  'Conflict of Interest Statement',
  'cois',
  // 日付
  'Date - Publication',
  'dp',
  'pdat',
  'Date - Entrez',
  'edat',
  'Date - MeSH',
  'mhda',
  'Date - Create',
  'crdt',
  'Date - Completion',
  'dcom',
  'Date - Modification',
  'lr',
  // その他の識別子・分類
  'Subset',
  'sb',
  'Secondary Source ID',
  'si',
  'Grant Number',
  'gr',
  'EC/RN Number',
  'rn',
  'Pharmacological Action',
  'pa',
  'Filter',
];

const FIELD_TAG_ALTERNATION = KNOWN_FIELD_TAG_NAMES.map((name) =>
  name.replace(/\//g, '\\/')
).join('|');

/**
 * `[Mesh]` `[tiab]` 等の既知タグ（`:NoExp` `:~N` 等の修飾つきも可）に一致する。
 * 前置の空白も合わせて除去できるよう `\s*` を含める。
 */
const KNOWN_FIELD_TAG_PATTERN = new RegExp(
  `\\s*\\[(?:${FIELD_TAG_ALTERNATION})(?::[^\\]]*)?\\]`,
  'gi'
);

/** 文字列から既知の PubMed フィールドタグを丸ごと除去する。 */
export function stripKnownPubmedFieldTags(text: string): string {
  return text.replace(KNOWN_FIELD_TAG_PATTERN, '');
}

/**
 * {@link stripKnownPubmedFieldTags} で除去しきれず残った `[...]` を検出する。
 *
 * PubMed 検索式の文法では角括弧はフィールドタグにしか使われないため、既知タグ
 * 除去後に残る角括弧は「ホワイトリストに無い＝取りこぼした」タグとみなしてよい。
 * ここでは（誤って本文を削ってしまわないよう）検出のみ行い、削除はしない。
 * 検出対象を絞り込みすぎて見落とすより、多少過検出でも警告で気づける方を優先する。
 */
export function detectResidualFieldTagBrackets(text: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/\[[^\]]+\]/g)) {
    const raw = match[0];
    if (!seen.has(raw)) {
      seen.add(raw);
      found.push(raw);
    }
  }
  return found;
}
