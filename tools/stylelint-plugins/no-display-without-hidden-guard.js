/**
 * stylelint カスタムルール: sr-query-builder/no-display-without-hidden-guard
 *
 * 目的: `display: <none 以外>` を含むルール群を「ID/クラス単独セレクタ」に直書きしている箇所を
 * 警告する。`hidden` 属性で隠しているセクションが、後発の display 指定によって
 * 再び見えてしまう副作用（popup のセクション同時表示バグ）の予防。
 *
 * 想定ガード（いずれかでフォールバック可）:
 *   1. globals.css に [hidden] { display: none !important } を入れている
 *      → `require-hidden-attr-reset` ルールで担保
 *   2. セレクタに `:not([hidden])` を付けて display を限定している
 *
 * 本ルールはあくまで「機械的なリマインダ」。globals.css の !important リセットが
 * 一次防衛なので severity は warning に留め、CI を即落とすほど強くしない。
 *
 * docs/ui-review-strategy.md §3 Tier 0 に対応する。
 */

'use strict';

const stylelint = require('stylelint');

const ruleName = 'sr-query-builder/no-display-without-hidden-guard';

const messages = stylelint.utils.ruleMessages(ruleName, {
  missingGuard: (selector) =>
    `'${selector}' に display を直書きしています。hidden 属性で隠す可能性があるなら ` +
    `globals.css の [hidden] リセットに頼るか、セレクタに :not([hidden]) を付けてください。`,
});

const meta = {
  url: 'docs/ui-review-strategy.md#tier-0-css-規約実装済-stylelint-で固定化',
};

/** ID / クラス / タグ単独セレクタ（コンビネータも疑似クラスも持たない）かを判定する */
function isSingleSimpleSelector(selector) {
  const trimmed = selector.trim();
  if (!trimmed) return false;
  if (/[\s>+~,]/.test(trimmed)) return false;
  if (/[:\[]/.test(trimmed)) return false;
  return /^[#.]?[A-Za-z][\w-]*$/.test(trimmed);
}

const ruleFunction = (primary, secondaryOptions) => {
  return (root, result) => {
    const validOptions = stylelint.utils.validateOptions(
      result,
      ruleName,
      { actual: primary, possible: [true] },
      {
        actual: secondaryOptions,
        possible: {
          ignoreSelectors: [(v) => typeof v === 'string'],
        },
        optional: true,
      }
    );
    if (!validOptions) return;

    const ignore = new Set((secondaryOptions && secondaryOptions.ignoreSelectors) || []);

    root.walkRules((rule) => {
      // セレクタリスト全体が単独セレクタのみで構成されている時だけ対象
      const selectors = rule.selectors.map((s) => s.trim());
      if (!selectors.every(isSingleSimpleSelector)) return;
      if (selectors.some((s) => ignore.has(s))) return;

      rule.walkDecls('display', (decl) => {
        if (decl.value.trim() === 'none') return;
        stylelint.utils.report({
          message: messages.missingGuard(rule.selector),
          node: decl,
          result,
          ruleName,
          severity: 'warning',
        });
      });
    });
  };
};

ruleFunction.ruleName = ruleName;
ruleFunction.messages = messages;
ruleFunction.meta = meta;

module.exports = stylelint.createPlugin(ruleName, ruleFunction);
module.exports.ruleName = ruleName;
module.exports.messages = messages;
module.exports.meta = meta;
