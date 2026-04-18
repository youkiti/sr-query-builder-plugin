/**
 * search_formula.md の PubMed セクションを表す型。
 * ルートリポジトリの仕様（requirements.md §4.4）：
 * - `## PubMed/MEDLINE` または `## PubMed` セクション
 * - その直後のフェンスドコードブロック（```）内に本体
 * - 各行は `#<id> <expression>` 形式
 * - id は数値（`1`, `2A`）または英数（`RCTfilter`）
 * - 結合行は最後のブロックで、他ブロック ID への参照を含む
 */

export interface FormulaBlock {
  /** 先頭の `#` を除いた識別子（例: `"1"`, `"2A"`, `"RCTfilter"`） */
  id: string;
  /** `#id ` 以降の検索式本体 */
  expression: string;
  /**
   * 他ブロック ID への参照を含む結合行かどうか。
   * 例: `#3 #1 AND #2` → true
   * 自身の ID しか含まないもの（または参照なし）→ false
   */
  isCombination: boolean;
}

export interface PubmedFormula {
  /** 出現順のブロック一覧 */
  blocks: FormulaBlock[];
  /** `isCombination=true` の最後のブロックの expression。無ければ null */
  combinationExpression: string | null;
}

/** セクション見出しとして受け付ける正規表現 */
export const PUBMED_HEADING_PATTERN = /^##\s+(?:PubMed(?:\/MEDLINE)?)\s*$/im;

/** ブロック ID として許可する文字（英数字のみ、最低 1 文字） */
export const BLOCK_ID_PATTERN = /^[A-Za-z0-9]+$/;
