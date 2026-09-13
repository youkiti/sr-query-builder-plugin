/** @jest-environment node */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, readApiAudit, renderApiAudit } from './apiAudit';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'api-audit-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const at = (ms: number) => new Date(Date.UTC(2026, 8, 13) + ms).toISOString();
const api = (ms: number, status = 200, route = 'esearch', method = 'GET', attempt = 1) => ({
  api: 'ncbi', url: `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/${route}.fcgi`,
  startedAt: at(ms), status, method, attempt, elapsedMs: 500,
});
function write(events: unknown[], target = join(dir, 'progress.jsonl')): string {
  writeFileSync(target, events.map((event) => JSON.stringify({ at: at(9999), event })).join('\n') + '\n');
  return target;
}

test('完了順ではなく送信順に再帰統合し、ステータス・経路・窓・直前 5 件・待機を出す', () => {
  write([api(1000, 429, 'esearch', 'POST', 2), api(0), api(900, 414),
    { limiter: { at: at(0), waitedMs: 120, bucket: 'withoutApiKey' } },
    { process: { pid: 123, hasApiKey: false, caseCount: 3, caseExecution: 'sequential', gitCommit: 'abc', runId: 'run' } }]);
  mkdirSync(join(dir, 'child'));
  write([api(950), api(800, 502, 'efetch'), api(700, 200, 'esummary'), api(1100),
    { limiter: { waitedMs: 300 } },
    { ...api(925, 429), url: 'https://id.nlm.nih.gov/mesh/sparql' },
    { ...api(926, 429), api: 'llm', url: 'https://generativelanguage.googleapis.com/model' }], join(dir, 'child', 'progress.jsonl'));
  writeFileSync(join(dir, 'run.json'), '読み込まない');
  const audit = readApiAudit(dir);
  expect(audit.files).toBe(2);
  expect(audit.requests).toHaveLength(7);
  const output = renderApiAudit(audit);
  for (const text of ['200 × esearch GET: 3 件', '429 × esearch POST: 1 件', '414 × esearch GET: 1 件',
    '502 × efetch GET: 1 件', '200 × esummary GET: 1 件', '最大リクエスト数: 6 件', '合計 420 ms、最大 300 ms',
    'PID=123', 'API キー=なし', '対象ケース=3', 'ケース実行=逐次']) expect(output).toContain(text);
  const history = output.split('\n').filter((line) => line.startsWith('  '));
  expect(history).toHaveLength(5);
  expect(history.map((line) => line.split(' / ')[0]!.trim())).toEqual([0, 700, 800, 900, 950].map(at));
  expect(output).toContain(`${at(1000)} / 間隔 50 ms / esearch POST / 試行 2`);
});

test('秒境界をまたぐ窓とちょうど 1000 ms の除外を固定する', () => {
  const path = write([api(999), api(1000), api(1999)]);
  expect(renderApiAudit(readApiAudit(path))).toContain('最大リクエスト数: 2 件');
});

test.each([
  [{ requestConcurrency: 'caller-dependent', externalConcurrency: 'unknown' }, '呼び出し側依存'],
  [{}, '不明'],
  [{ requestConcurrency: '未対応の値', externalConcurrency: '未対応の値' }, '不明'],
])('プロセスの並行性は記録値を表示し、未記録・未知なら不明にする: %j', (process, expected) => {
  const output = renderApiAudit(readApiAudit(write([{ process }])));
  expect(output).toContain(`要求の並行性=${expected}、外部並行実行=不明`);
});

test('同時刻の別リクエストを重複除去せず、直前履歴が無い 429 も表示する', () => {
  const output = renderApiAudit(readApiAudit(write([api(0, 429), api(0, 429)])));
  expect(output).toContain('最大リクエスト数: 2 件');
  expect(output).toContain('直前の記録なし');
  expect(output).toContain('間隔 0 ms');
});

test('古いログの時刻・試行・方式は推定せず欠測として残す', () => {
  const output = renderApiAudit(readApiAudit(write([
    { api: 'ncbi', url: api(0).url, status: 429, elapsedMs: 100 }, { status: 'completed' },
  ])));
  for (const text of ['429 × esearch 方式不明', '送信時刻の欠測: 1', '試行番号の欠測: 1',
    '直前履歴を復元できません', '待機ログなし', 'プロセス条件の記録なし']) expect(output).toContain(text);
});

test('入力なし・ファイルなし・空ディレクトリはエラーにする', () => {
  expect(() => main([])).toThrow('使い方');
  expect(() => readApiAudit(join(dir, 'missing'))).toThrow('存在しません');
  expect(() => readApiAudit(dir)).toThrow('progress.jsonl がありません');
});

test('壊れた JSON と途中の空行は本文を出さずファイル・行を示して停止する', () => {
  const path = write([api(0)]);
  for (const bad of ['壊れた本文', '']) {
    writeFileSync(path, JSON.stringify({ event: api(0) }) + '\n' + bad + '\n');
    expect(() => readApiAudit(path)).toThrow(`JSON 行が壊れています: ${path}:2`);
  }
});

test.each([null, {}, { event: { api: 'ncbi', url: '不正' } },
  { event: { ...api(0), status: '429' } }, { event: { ...api(0), startedAt: '不正' } },
  { event: { ...api(0), attempt: 0 } }, { event: { limiter: { waitedMs: -1 } } },
])('意味的に不正なログ行も黙って無視しない: %j', (row) => {
  const path = join(dir, 'progress.jsonl');
  writeFileSync(path, JSON.stringify(row));
  expect(() => readApiAudit(path)).toThrow(`${path}:1`);
});

test('CLI は日本語を標準出力へ書き、空ファイルも件数 0 として明示する', () => {
  const path = join(dir, 'progress.jsonl');
  writeFileSync(path, '');
  const stdout = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
  try {
    main([path]);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('E-utilities 0 件'));
  } finally { stdout.mockRestore(); }
});
