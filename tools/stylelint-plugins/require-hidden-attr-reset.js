/**
 * stylelint カスタムルール: sr-query-builder/require-hidden-attr-reset
 *
 * 目的: 共通 CSS（src/styles/globals.css）に
 *   [hidden] { display: none !important; }
 * のリセットが存在することを保証する。
 *
 * 背景: UA スタイルの `[hidden] { display: none }` は specificity (0,1,0)。
 * `.popup__section { display: flex }` 等の後発ルールが勝つと `hidden` 属性が
 * 効かなくなる（popup のログイン/プロジェクト両セクション同時表示バグ）。
 * !important を含む明示リセットを入れておくのが最低限の防衛策。
 *
 * 適用対象は overrides で globals.css に限定する想定。
 * docs/ui-review-strategy.md §3 Tier 0 に対応する。
 */

'use strict';

const stylelint = require('stylelint');

const ruleName = 'sr-query-builder/require-hidden-attr-reset';

const messages = stylelint.utils.ruleMessages(ruleName, {
  missing: () =>
    '[hidden] { display: none !important } のリセット宣言が見つかりません。' +
    'UA スタイルが他の display 指定に負けないよう必ず !important で固定してください。',
});

const meta = {
  url: 'docs/ui-review-strategy.md#tier-0-css-規約実装済-stylelint-で固定化',
};

const ruleFunction = (primary) => {
  return (root, result) => {
    const validOptions = stylelint.utils.validateOptions(result, ruleName, {
      actual: primary,
      possible: [true],
    });
    if (!validOptions) return;

    let satisfied = false;
    root.walkRules((rule) => {
      const selectors = rule.selectors.map((s) => s.trim());
      if (!selectors.includes('[hidden]')) return;
      rule.walkDecls('display', (decl) => {
        if (decl.value.trim() === 'none' && decl.important) {
          satisfied = true;
        }
      });
    });

    if (!satisfied) {
      stylelint.utils.report({
        message: messages.missing(),
        node: root,
        result,
        ruleName,
      });
    }
  };
};

ruleFunction.ruleName = ruleName;
ruleFunction.messages = messages;
ruleFunction.meta = meta;

module.exports = stylelint.createPlugin(ruleName, ruleFunction);
module.exports.ruleName = ruleName;
module.exports.messages = messages;
module.exports.meta = meta;
