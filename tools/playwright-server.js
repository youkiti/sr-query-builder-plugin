/**
 * Playwright 用の最小静的ファイルサーバ。
 *
 * 役割: webpack でビルドした dist/ を localhost:4400 で配信し、
 * tests/e2e/*.spec.ts から `file://` ではなく HTTP で読み込めるようにする。
 *
 * `file://` だと ES modules（popup.html の `<script type="module">`）が CORS で
 * 弾かれるため、HTTP 経由が必要。第三者 npm を増やさず Node 標準モジュールで実装。
 *
 * 使い方:
 *   node tools/playwright-server.js [--port 4400] [--root dist]
 *
 * Playwright の `webServer` セクションから起動される想定。Ctrl+C で終了する。
 */

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
function readArg(name, fallback) {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

const PORT = Number(readArg('port', '4400'));
const ROOT = path.resolve(process.cwd(), readArg('root', 'dist'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.map': 'application/json; charset=utf-8',
};

function safeJoin(rootDir, requestPath) {
  const decoded = decodeURIComponent(requestPath.split('?')[0]);
  const joined = path.normalize(path.join(rootDir, decoded));
  if (!joined.startsWith(rootDir)) return null;
  return joined;
}

const server = http.createServer((req, res) => {
  const filePath = safeJoin(ROOT, req.url || '/');
  if (!filePath) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.stat(filePath, (err, stats) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    const target = stats.isDirectory() ? path.join(filePath, 'index.html') : filePath;
    fs.readFile(target, (readErr, data) => {
      if (readErr) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }
      const mime = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': mime,
        'Cache-Control': 'no-store',
      });
      res.end(data);
    });
  });
});

server.listen(PORT, () => {
  // Playwright webServer はこの行の URL ヘルスチェックを使うため、
  // 起動完了をログに出して確実にレディネスを見せる。
  // eslint-disable-next-line no-console
  console.log(`[playwright-server] serving ${ROOT} at http://localhost:${PORT}`);
});

process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => {
  server.close();
  process.exit(0);
});
