import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TextDecoder } from 'node:util';
import type { Command, Conditions } from './conditions';

const REJECTED = 'この呼び出しは受け付けられません（使えるのは check / count / submit に formula.md、mesh に語を 1 つ、だけです）';
export interface ToolReply { code: number; stdout: string; stderr: string }
export interface RelayOptions {
  conditions: Conditions;
  runTool: (args: string[], signal: AbortSignal) => Promise<ToolReply>;
  intervalMs?: number;
  timeoutMs?: number;
}

export function parseRequest(bytes: Buffer, conditions: Conditions): { ok: true; args: string[] } | { ok: false; message: string } {
  const rejected = { ok: false as const, message: REJECTED };
  if (!bytes.length || bytes.length > 2000) return rejected;
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return rejected; }
  const args = text.split('\0');
  if (args[args.length - 1] === '') args.pop();
  const [command, argument] = args;
  if (args.length !== 2 || !command || !['check', 'count', 'mesh', 'submit'].includes(command)
    || !conditions.tools.includes(command as Command) || argument === undefined) return rejected;
  if (command === 'mesh') {
    const length = Array.from(argument.trim()).length;
    if (length < 1 || length > 200 || /\p{Cc}/u.test(argument)) return rejected;
  } else if (argument !== 'formula.md') return rejected;
  return { ok: true, args };
}

function formulaAllowed(dir: string): boolean {
  try { const stat = lstatSync(join(dir, 'formula.md')); return stat.isFile() && stat.size <= 200_000; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
}

async function invoke(args: string[], options: RelayOptions): Promise<ToolReply> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(() => options.runTool(args, controller.signal)),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('中継の制限時間を超えました')); }, options.timeoutMs ?? 600_000);
      })]);
  } finally { clearTimeout(timer); }
}

export function serveRun(dir: string, options: RelayOptions): { stop(): Promise<void> } {
  const relay = join(dir, '.relay');
  mkdirSync(relay, { recursive: true });
  if (!lstatSync(relay).isDirectory() || lstatSync(relay).isSymbolicLink()) throw new Error('中継フォルダが不正です');
  let stopped = false;
  let wake: (() => void) | undefined;
  async function processRequest(name: string): Promise<void> {
    const base = join(relay, name.slice(0, -4));
    if (existsSync(`${base}.done`)) return;
    try { writeFileSync(`${base}.taken`, '', { flag: 'wx' }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return; throw error; }
    let reply: ToolReply = { code: 2, stdout: '', stderr: REJECTED };
    try {
      const stat = lstatSync(`${base}.req`);
      if (stat.isFile() && stat.size <= 2000) {
        const request = parseRequest(readFileSync(`${base}.req`), options.conditions);
        if (request.ok && (request.args[0] === 'mesh' || formulaAllowed(dir))) reply = await invoke(request.args, options);
      }
    } catch { reply = { code: 3, stdout: '', stderr: '測定に失敗しました（中継役の内部エラー）' }; }
    // 排他的に書き、応答先に置かれたリンクをたどらない。完了印は必ず最後に作る。
    writeFileSync(`${base}.out`, reply.stdout, { flag: 'wx' });
    writeFileSync(`${base}.err`, reply.stderr, { flag: 'wx' });
    writeFileSync(`${base}.code`, String(reply.code), { flag: 'wx' });
    writeFileSync(`${base}.done`, '', { flag: 'wx' });
  }
  const loop = (async () => {
    while (!stopped) {
      for (const name of readdirSync(relay).sort()) {
        if (stopped) break;
        if (/^[A-Za-z0-9-]{1,80}\.req$/.test(name)) await processRequest(name);
      }
      if (!stopped) await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, options.intervalMs ?? 300);
        wake = () => { clearTimeout(timer); resolve(); };
      });
    }
  })();
  // 終了時に呼び出し元へ返すまで、監視ループの例外を保持する。
  void loop.catch(() => undefined);
  return { async stop() { stopped = true; wake?.(); await loop; } };
}
