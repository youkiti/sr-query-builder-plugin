/**
 * プロンプトテンプレート中の `{{KEY}}` プレースホルダを値で置換する。
 *
 * `String.prototype.replace(pattern, replacement)` は replacement 文字列側の
 * `$&` / `$'` / `` $` `` / `$1`〜`$9` / `$$` を置換パターンとして特殊解釈する。
 * ユーザー由来の値（式・指示文・兄弟ブロックの内容など）に `$` を含む文字列
 * （例: Embase の切り捨て記法 `drug$`）が混ざると、意図せず展開されてテンプレートが
 * 壊れる・重複する（issue #92 C-1）。`split(needle).join(value)` は replacement を
 * 特殊解釈しないため、この事故を避けられる。
 *
 * `values` は `{{KEY}}` の `KEY` 部分（波括弧なし）をキーにした置換値のマップ。
 */
export function renderPromptTemplate(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce(
    (acc, [key, value]) => acc.split(`{{${key}}}`).join(value),
    template
  );
}
