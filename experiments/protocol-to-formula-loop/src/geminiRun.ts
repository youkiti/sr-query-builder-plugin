import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { config } from 'dotenv';
import { TokenBucket } from '../../../src/lib/ncbi/rateLimit';
import { redact } from '../../query-optimization-bench/ncbiEval';
import { casesDir } from './cases';
import { loadConditions, type Command } from './conditions';
import { procedureBody } from './leakCheck';
import { ncbiRate } from './ncbi';
import { createRun, readRun, runPath } from './runDir';
import { parseRunOptions, targetReviews, type RunRuntime } from './startRuns';
import { defaultRuntime, main as toolMain } from './tool';

export const SETTINGS = `## この作業の設定

- \`TOOL\` は関数 \`tool\` です。\`TOOL check <検索式ファイル>\` は \`tool(command="check")\`、\`TOOL count <検索式ファイル>\` は \`tool(command="count")\`、\`TOOL mesh "<語>"\` は \`tool(command="mesh", argument="<語>")\`、\`TOOL outside <検索式ファイル> <ブロックの ID>\` は \`tool(command="outside", argument="<ブロックの ID>")\`、\`TOOL submit <検索式ファイル>\` は \`tool(command="submit")\` と呼びます。
- 検索式ファイル（formula.md）は、関数 \`write_formula(content="...")\` で書きます。書き直すたびに全文を渡してください。道具は、最後に書いた formula.md を読みます。
- プロトコル（protocol.md）の内容は、最初のメッセージに入っています。ほかのファイルは読めません。
- 関数は 1 回の応答で 1 つずつ呼んでください。
- 道具が「測定に失敗しました」と返したら、同じ呼び出しをもう一度だけ試してください。
- 提出が受け付けられたら、関数を呼ばずに、提出した式とブロックごとの考え方を短く書いて終わってください。`;
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/';
type Status = 'completed' | 'max_turns' | 'error';
interface Agent {
  status: Status; model: string; modelVersion: string | null; turns: number; startedAt: string; finishedAt: string;
  promptTokens: number; outputTokens: number; thinkingLevel: string | null; thoughtsTokens: number; note?: string;
}
export interface FunctionCall { name: string; args?: Record<string, unknown>; id?: string }
interface Part { text?: string; thought?: boolean; functionCall?: FunctionCall }
interface Content { role?: string; parts?: Part[] }
interface Reply {
  candidates?: { content?: Content; finishReason?: string }[]; modelVersion?: string;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number; thoughtsTokenCount?: number };
}
export const safeText = (runtime: RunRuntime, text: string) => redact(text, [runtime.env.GEMINI_API_KEY ?? '', runtime.env.OPENROUTER_API_KEY ?? '', runtime.env.NCBI_API_KEY ?? '']);
const tokens = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;

export function parseOptions(args: string[]) {
  const rest: string[] = [];
  let concurrency = 4;
  let found = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--concurrency') { rest.push(args[i]!); continue; }
    if (found || !/^[1-8]$/.test(args[i + 1] ?? '')) throw new Error('並行数は 1〜8 の整数を指定してください');
    found = true; concurrency = Number(args[++i]);
  }
  return { ...parseRunOptions(rest, '--runs'), concurrency };
}

async function generate(url: string, body: unknown, runtime: RunRuntime, failed: (attempt: number) => void): Promise<{ reply: Reply; attempt: number }> {
  const sleep = runtime.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    let retry = true;
    try {
      const response = await runtime.fetchImpl(url, { method: 'POST', headers: {
        'x-goog-api-key': runtime.env.GEMINI_API_KEY!, 'Content-Type': 'application/json',
      }, body: JSON.stringify(body), signal: controller.signal });
      if (!response.ok) {
        retry = [429, 500, 502, 503, 504].includes(response.status);
        throw new Error(`Gemini の要求に失敗しました（HTTP ${response.status}）`);
      }
      const reply: unknown = await response.json();
      if (!reply || typeof reply !== 'object' || 'error' in reply) throw new Error('Gemini の応答が不正です');
      return { reply: reply as Reply, attempt: attempt + 1 };
    } catch (error) {
      failed(attempt + 1);
      if (!retry || attempt >= 5 || !url.startsWith(ENDPOINT)) throw new Error(safeText(runtime, String(error)));
    } finally { clearTimeout(timer); }
    await sleep(1000 * 2 ** attempt);
  }
}

export async function callFunction(call: FunctionCall, dir: string, commands: Command[], runtime: RunRuntime): Promise<string> {
  const args = call.args ?? {};
  const file = resolve(dir, 'formula.md');
  if (call.name === 'write_formula') {
    if (typeof args.content !== 'string') return 'エラー: content は文字列で指定してください';
    writeFileSync(file, safeText(runtime, args.content));
    return `formula.md を書きました（${args.content.length} 文字）`;
  }
  if (call.name !== 'tool') return 'エラー: 未知の関数です';
  if (typeof args.command !== 'string' || !commands.includes(args.command as Command)) return 'エラー: この版では使えないコマンドです';
  const command = args.command;
  if (command !== 'mesh' && !existsSync(file)) return '先に write_formula で formula.md を書いてください';
  if ((command === 'mesh' || command === 'outside') && typeof args.argument !== 'string') return 'エラー: argument は文字列で指定してください';
  const argument = typeof args.argument === 'string' ? safeText(runtime, args.argument) : '';
  const toolArgs = ['--run', dir, command, ...(command === 'mesh' ? [argument] : [file]), ...(command === 'outside' ? [argument] : [])];
  let output = '';
  const collect = (text: string) => { output += safeText(runtime, text); };
  try {
    const code = await toolMain(toolArgs, { ...runtime, stdout: collect, stderr: collect,
      fetchImpl: async (input, init) => {
        try { return await runtime.fetchImpl(input, init); }
        catch (error) { throw new Error(safeText(runtime, String(error))); }
      } });
    return `${output}\n[終了コード ${code}]`;
  } catch (error) { return `${output}${safeText(runtime, String(error))}\n[終了コード 1]`; }
}

async function runAgent(dir: string, procedure: string, runtime: RunRuntime): Promise<Agent> {
  const { conditions } = readRun(dir);
  const agent: Agent = { status: 'max_turns', model: conditions.model, modelVersion: null, turns: 0,
    startedAt: runtime.now().toISOString(), finishedAt: '', promptTokens: 0, outputTokens: 0, thinkingLevel: conditions.thinkingLevel ?? null, thoughtsTokens: 0 };
  const save = (name: string, value: unknown) => writeFileSync(join(dir, name), safeText(runtime, JSON.stringify(value, null, 2)) + '\n');
  const log = (value: unknown) => appendFileSync(join(dir, 'agent-log.jsonl'), safeText(runtime, JSON.stringify(value)) + '\n');
  const contents: unknown[] = [{ role: 'user', parts: [{ text: '次の研究プロトコルについて、手順書に従って検索式を作り、提出してください。\n\n'
    + readFileSync(join(dir, 'protocol.md'), 'utf8') }] }];
  const functionDeclarations = [
    { name: 'write_formula', description: '検索式の全文を書く', parameters: { type: 'OBJECT', properties: { content: { type: 'STRING' } }, required: ['content'] } },
    { name: 'tool', description: '手順書の道具を呼ぶ', parameters: { type: 'OBJECT', properties: {
      command: { type: 'STRING', enum: conditions.tools }, argument: { type: 'STRING' },
    }, required: ['command'] } },
  ];
  let empty = false;
  try {
    for (let turn = 1; turn <= 60; turn++) {
      agent.turns = turn;
      const { reply, attempt } = await generate(`${ENDPOINT}${conditions.model}:generateContent`, {
        systemInstruction: { parts: [{ text: `${procedure}\n\n${SETTINGS}` }] }, contents, tools: [{ functionDeclarations }],
        ...(conditions.thinkingLevel === undefined ? {} : { generationConfig: { thinkingConfig: { thinkingLevel: conditions.thinkingLevel } } }),
      }, runtime, (attempt) => log({ turn, attempt, at: runtime.now().toISOString(), type: 'error', resultLength: 0 }));
      if (typeof reply.modelVersion === 'string') agent.modelVersion = safeText(runtime, reply.modelVersion);
      const usage = { promptTokenCount: tokens(reply.usageMetadata?.promptTokenCount),
        candidatesTokenCount: tokens(reply.usageMetadata?.candidatesTokenCount), totalTokenCount: tokens(reply.usageMetadata?.totalTokenCount),
        thoughtsTokenCount: tokens(reply.usageMetadata?.thoughtsTokenCount) };
      agent.promptTokens += usage.promptTokenCount; agent.outputTokens += usage.candidatesTokenCount; agent.thoughtsTokens += usage.thoughtsTokenCount;
      const content = reply.candidates?.[0]?.content;
      const parts = Array.isArray(content?.parts) ? content.parts : [];
      const calls = parts.flatMap((part) => part.functionCall ? [part.functionCall] : []);
      const call = calls[0];
      const text = parts.filter((part) => part.thought !== true).map((part) => typeof part.text === 'string' ? part.text : '').join('');
      let result = '';
      try {
        if (call) {
          result = await callFunction(call, dir, conditions.tools, runtime);
          if (calls.length > 1) result += '\n複数の関数が指定されたため、最初の 1 つだけ実行しました。';
          contents.push(content, { role: 'user', parts: calls.map((item, index) => ({ functionResponse: {
            name: item.name, ...(item.id === undefined ? {} : { id: item.id }),
            response: { result: index === 0 ? result : '未実行: 関数は 1 回の応答で 1 つずつ呼んでください。' },
          } })) });
          empty = false;
        } else if (text) {
          writeFileSync(join(dir, 'final.txt'), safeText(runtime, text)); agent.status = 'completed';
        } else if (empty) {
          agent.status = 'completed'; agent.note = '応答が 2 回続けて空でした';
        } else {
          empty = true; contents.push({ role: 'user', parts: [{ text: '応答が空でした。続けてください。' }] });
        }
      } finally {
        const args = call?.args ?? {};
        log({ turn, attempt, at: runtime.now().toISOString(), type: call ? (['write_formula', 'tool'].includes(call.name) ? call.name : 'unknown') : text ? 'text' : 'empty',
          arguments: call?.name === 'write_formula' ? { contentLength: typeof args.content === 'string' ? args.content.length : 0 }
            : call?.name === 'tool' ? { command: conditions.tools.includes(args.command as Command) ? args.command : 'unknown',
              argumentLength: typeof args.argument === 'string' ? args.argument.length : 0 } : undefined,
          resultLength: result.length, usageMetadata: usage });
      }
      if (agent.status === 'completed') break;
    }
  } catch (error) { agent.status = 'error'; agent.note = safeText(runtime, String(error)); }
  agent.finishedAt = runtime.now().toISOString();
  save('agent.json', agent);
  return agent;
}

async function execute(args: string[], runtime: RunRuntime): Promise<number> {
  const options = parseOptions(args);
  const conditions = loadConditions(options.version, runtime.harnessDir);
  if ((conditions.runner ?? 'claude-subagent') !== 'gemini-api') throw new Error('実行役が gemini-api の版を指定してください');
  if (conditions.combine) throw new Error('束ねた版は実行できません');
  if (!runtime.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY が必要です');
  const procedure = procedureBody(readFileSync(join(runtime.harnessDir ?? resolve(__dirname, '../harness'), options.version, 'procedure.md'), 'utf8'));
  const reviews = targetReviews(options, runtime);
  const jobs = reviews.flatMap((review) => Array.from({ length: options.runsPerReview }, (_, i) => ({ review, runIndex: i + 1 })));
  const counts = { completed: 0, max_turns: 0, error: 0 };
  let skipped = 0, rebuilt = 0, executed = 0, promptTokens = 0, outputTokens = 0, thoughtsTokens = 0, next = 0;
  const toolRuntime = { ...runtime, rateLimiter: new TokenBucket({ ratePerSecond: ncbiRate(runtime.env), capacity: 1,
    now: () => runtime.now().getTime(), sleep: runtime.sleep }) };
  await Promise.all(Array.from({ length: options.concurrency }, async () => {
    while (next < jobs.length) {
      const { review, runIndex } = jobs[next++]!;
      const dir = runPath(options.root, options.version, review.pmcid, runIndex);
      if (existsSync(dir)) {
        const agentPath = join(dir, 'agent.json');
        let status: unknown;
        if (existsSync(agentPath)) {
          try { status = (JSON.parse(readFileSync(agentPath, 'utf8')) as Agent).status; }
          catch { status = 'error'; }
        }
        if (status === 'completed' || status === 'max_turns') { skipped++; continue; }
        let stamp = runtime.now().getTime();
        let backup: string;
        do { backup = `${dir}.failed-${new Date(stamp).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}`; stamp += 1000; }
        while (existsSync(backup));
        renameSync(dir, backup); rebuilt++;
      }
      createRun({ root: options.root, version: options.version, pmcid: review.pmcid, runIndex, cutoffDate: review.cutoffDate,
        protocolPath: join(runtime.casesDir ?? casesDir(), review.pmcid, 'protocol.md'), conditions, now: runtime.now });
      executed++;
      const agent = await runAgent(dir, procedure, toolRuntime);
      counts[agent.status]++; promptTokens += agent.promptTokens; outputTokens += agent.outputTokens; thoughtsTokens += agent.thoughtsTokens;
    }
  }));
  for (const line of [`対象: ${jobs.length} 件`, `今回実行: ${executed} 件`, `済みで省略: ${skipped} 件`, `作り直し: ${rebuilt} 件`,
    `completed: ${counts.completed} 件`, `max_turns: ${counts.max_turns} 件`, `error: ${counts.error} 件`,
    `入力トークン: ${promptTokens}`, `出力トークン: ${outputTokens}`, `推論トークン: ${thoughtsTokens}`]) runtime.stdout(line + '\n');
  return counts.error ? 1 : 0;
}

export async function main(args: string[], runtime: RunRuntime = defaultRuntime()): Promise<number> {
  try { return await execute(args, runtime); }
  catch (error) { throw new Error(safeText(runtime, String(error))); }
}
if (require.main === module) {
  config();
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(redact(String(error), [process.env.GEMINI_API_KEY ?? '', process.env.NCBI_API_KEY ?? '']) + '\n'); process.exitCode = 1;
  });
}
