// 実物の公開ヘルプを本番と同じ抽出関数で変換して Jest に渡す。
const { readFileSync } = require('fs');
const { join } = require('path');
const { parseHelpSections } = require('../../tools/webpack/help-sections.cjs');
module.exports = parseHelpSections(readFileSync(join(__dirname, '../../hosted/help.html'), 'utf8'), 'ja');
