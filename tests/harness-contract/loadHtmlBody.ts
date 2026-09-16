import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * 実ファイル（popup.html / options.html 等）の `<body>` 中身を、jsdom document へ
 * そのまま流し込める文字列として返す。
 *
 * bootstrap.ts 側だけを見て手組みした fabricated スケルトン（既存の
 * src/popup/bootstrap.test.ts 等）は、HTML 側で id が rename・削除されても検知できない
 * （スケルトンは bootstrap.ts の期待に合わせて書かれるため、常に「期待どおり」になる）。
 * 実ファイルを読むことで、tools/selenium・video/scenes が依存する実際のマークアップに対して
 * 検証する。
 *
 * `<script>` はブラウザ専用の副作用（chrome.* 呼び出し等）を持つため読み込む前に取り除く。
 */
export function loadHtmlBody(relativePathFromRepoRoot: string): string {
  const absolute = path.resolve(__dirname, '../..', relativePathFromRepoRoot);
  const raw = readFileSync(absolute, 'utf8');
  const withoutScripts = raw.replace(/<script[\s\S]*?<\/script>/gi, '');
  const match = /<body[^>]*>([\s\S]*)<\/body>/i.exec(withoutScripts);
  if (!match) {
    throw new Error(`[harness-contract] <body> が見つかりません: ${relativePathFromRepoRoot}`);
  }
  return match[1] ?? '';
}
