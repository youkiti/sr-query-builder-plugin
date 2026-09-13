import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { redact } from './ncbiEval';

interface RequestRecord {
  source: string;
  route: string;
  status: number | null;
  startedAt: string | null;
  time: number | null;
  attempt: number | null;
}

export interface ApiAudit {
  files: number;
  requests: RequestRecord[];
  waits: number[];
  processes: { source: string; value: Record<string, unknown> }[];
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function progressFiles(path: string): string[] {
  if (!existsSync(path)) throw new Error(`入力が存在しません: ${path}`);
  if (statSync(path).isFile()) return [path];
  return readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? progressFiles(child) : entry.isFile() && entry.name === 'progress.jsonl' ? [child] : [];
  });
}

/** 壊れた行は場所だけを示して停止する。本文や URL の秘密をエラーへ転載しない。 */
export function readApiAudit(path: string): ApiAudit {
  const files = progressFiles(path);
  if (!files.length) throw new Error(`progress.jsonl がありません: ${path}`);
  const audit: ApiAudit = { files: files.length, requests: [], waits: [], processes: [] };
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    if (lines[lines.length - 1] === '') lines.pop();
    for (let index = 0; index < lines.length; index++) {
      const source = `${file}:${index + 1}`;
      let row: unknown;
      try { row = JSON.parse(lines[index]!); }
      catch { throw new Error(`JSON 行が壊れています: ${source}`); }
      if (!object(row) || !object(row.event)) throw new Error(`ログ行の形式が不正です: ${source}`);
      const event = row.event;
      if (object(event.process)) audit.processes.push({ source, value: event.process });
      if ('limiter' in event) {
        if (!object(event.limiter) || typeof event.limiter.waitedMs !== 'number'
          || !Number.isFinite(event.limiter.waitedMs) || event.limiter.waitedMs < 0) {
          throw new Error(`リミッタ待機時間が不正です: ${source}`);
        }
        audit.waits.push(event.limiter.waitedMs);
      }
      if (!('api' in event)) continue;
      if (typeof event.url !== 'string') throw new Error(`API URL が不正です: ${source}`);
      let url: URL;
      try { url = new URL(event.url); }
      catch { throw new Error(`API URL が不正です: ${source}`); }
      // 既存の api=ncbi には別ホストの SPARQL も含まれるため、実ホストで限定する。
      if (url.hostname !== 'eutils.ncbi.nlm.nih.gov') continue;
      if (event.status !== null && (typeof event.status !== 'number' || !Number.isInteger(event.status)
        || event.status < 100 || event.status > 599)) throw new Error(`HTTP ステータスが不正です: ${source}`);
      const startedAt = event.startedAt ?? null;
      if (startedAt !== null && (typeof startedAt !== 'string'
        || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(startedAt)
        || !Number.isFinite(Date.parse(startedAt)))) throw new Error(`送信時刻が不正です: ${source}`);
      const attempt = event.attempt ?? null;
      if (attempt !== null && (typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt < 1)) {
        throw new Error(`試行番号が不正です: ${source}`);
      }
      const method = typeof event.method === 'string' && /^(GET|POST)$/i.test(event.method)
        ? event.method.toUpperCase() : '方式不明';
      const endpoint = url.pathname.match(/\/(esearch|esummary|efetch)\.fcgi$/)?.[1] ?? 'その他';
      audit.requests.push({ source, route: `${endpoint} ${method}`, status: event.status as number | null,
        startedAt: startedAt as string | null, time: startedAt === null ? null : Date.parse(startedAt as string),
        attempt: attempt as number | null });
    }
  }
  return audit;
}

export function renderApiAudit(audit: ApiAudit): string {
  const lines = [`API 監査: ${audit.files} ファイル、E-utilities ${audit.requests.length} 件`,
    '対象ファイルを時刻で統合（別プロセスの時計のずれや、未収録の通信は補正しません）', '',
    'ステータス × 経路の件数'];
  const counts = new Map<string, number>();
  for (const request of audit.requests) {
    const key = `${request.status ?? '通信例外'} × ${request.route}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const [key, count] of [...counts].sort(([a], [b]) => a.localeCompare(b))) lines.push(`${key}: ${count} 件`);
  const ordered = audit.requests.filter((request) => request.time !== null).sort((a, b) => a.time! - b.time!);
  let left = 0;
  let maximum = 0;
  for (let right = 0; right < ordered.length; right++) {
    while (ordered[right]!.time! - ordered[left]!.time! >= 1000) left++;
    maximum = Math.max(maximum, right - left + 1);
  }
  lines.push('', `任意の 1 秒窓 [t, t+1000ms) の最大リクエスト数: ${maximum} 件`,
    `送信時刻の欠測: ${audit.requests.length - ordered.length} 件（欠測を含む場合、最大値・直前履歴は不完全）`,
    `試行番号の欠測: ${audit.requests.filter((request) => request.attempt === null).length} 件`, '', '429 と直前 5 件');
  const describe = (request: RequestRecord, previous?: RequestRecord) =>
    `${request.startedAt ?? '送信時刻不明'} / 間隔 ${previous && request.time !== null ? `${request.time - previous.time!} ms` : '不明'}`
    + ` / ${request.route} / 試行 ${request.attempt ?? '不明'} / ${request.source}`;
  for (let index = 0; index < ordered.length; index++) {
    const request = ordered[index]!;
    if (request.status !== 429) continue;
    lines.push(`429: ${describe(request, ordered[index - 1])}`);
    if (index === 0) lines.push('  直前の記録なし');
    for (let prior = Math.max(0, index - 5); prior < index; prior++) {
      lines.push(`  ${describe(ordered[prior]!, ordered[prior - 1])}`);
    }
  }
  for (const request of audit.requests.filter((item) => item.status === 429 && item.time === null)) {
    lines.push(`429: ${describe(request)}（直前履歴を復元できません）`);
  }
  lines.push('', `リミッタ待機: ${audit.waits.length} 件、合計 ${audit.waits.reduce((sum, wait) => sum + wait, 0)} ms、`
    + `最大 ${audit.waits.reduce((max, wait) => Math.max(max, wait), 0)} ms`
    + (audit.waits.length ? '' : '（待機ログなし）'), '', 'プロセス条件');
  if (!audit.processes.length) lines.push('プロセス条件の記録なし');
  const requestConcurrencyLabels = new Map<unknown, string>([['caller-dependent', '呼び出し側依存']]);
  const externalConcurrencyLabels = new Map<unknown, string>([['unknown', '不明']]);
  for (const { source, value } of audit.processes) {
    lines.push(`${source}: PID=${value.pid ?? '不明'}、API キー=${value.hasApiKey === true ? 'あり' : value.hasApiKey === false ? 'なし' : '不明'}、`
      + `対象ケース=${value.caseCount ?? '不明'}、ケース実行=${value.caseExecution === 'sequential' ? '逐次' : '不明'}、`
      + `要求の並行性=${requestConcurrencyLabels.get(value.requestConcurrency) ?? '不明'}、`
      + `外部並行実行=${externalConcurrencyLabels.get(value.externalConcurrency) ?? '不明'}、SHA=${value.gitCommit ?? '不明'}、run=${value.runId ?? '不明'}`);
  }
  return redact(lines.join('\n')) + '\n';
}

export function main(args = process.argv.slice(2)): void {
  if (args.length !== 1) throw new Error('使い方: npm run eval:api-audit -- <progress.jsonl またはディレクトリ>');
  process.stdout.write(renderApiAudit(readApiAudit(args[0]!)));
}

if (require.main === module) {
  try { main(); }
  catch (err) { process.stderr.write(redact(err instanceof Error ? err.message : String(err)) + '\n'); process.exitCode = 1; }
}
