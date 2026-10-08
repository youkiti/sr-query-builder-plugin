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
import { targetReviews, type RunRuntime } from './startRuns';
import { defaultRuntime } from './tool';

import { SETTINGS, safeText, callFunction, parseOptions, type FunctionCall } from './geminiRun';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
// 推論つきの長い応答（式の全文を書く応答など）が 120 秒では収まらない提供元があるため、Gemini の実行役より長く待つ。
const REQUEST_TIMEOUT_MS = 300_000;
type Status = 'completed' | 'max_turns' | 'error';
interface Agent {
  status: Status; model: string; modelVersion: string | null; provider: string; respondedProviders: string[];
  turns: number; startedAt: string; finishedAt: string;
  promptTokens: number;
  outputTokens: number; // OpenAI 互換の出力トークン数には推論のトークン数を含む。
  thinkingLevel: string | null; thoughtsTokens: number; cost: number | null;
  badArguments: number; emptyReplies: number; note?: string;
}
interface Message { role: string; content?: unknown; tool_calls?: unknown[]; [key: string]: unknown }
interface Reply {
  choices: { message: Message }[]; model?: string; provider?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number }; cost?: number };
}
const tokens = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
const costValue = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

async function generate(url: string, body: unknown, runtime: RunRuntime, failed: (attempt: number) => void): Promise<{ reply: Reply; attempt: number }> {
  const sleep = runtime.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let retry = true;
    try {
      const response = await runtime.fetchImpl(url, { method: 'POST', headers: {
        Authorization: `Bearer ${runtime.env.OPENROUTER_API_KEY!}`, 'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/youkiti/sr-query-builder-plugin', 'X-Title': 'sr-query-builder-plugin',
      }, body: JSON.stringify(body), signal: controller.signal });
      if (!response.ok) {
        retry = [429, 500, 502, 503, 504].includes(response.status);
        throw new Error(`OpenRouter の要求に失敗しました（HTTP ${response.status}）`);
      }
      const reply: unknown = await response.json();
      if (!object(reply) || 'error' in reply || !Array.isArray(reply.choices) || !object(reply.choices[0])
        || 'error' in reply.choices[0] || !object(reply.choices[0].message)) throw new Error('OpenRouter の応答が不正です');
      return { reply: reply as unknown as Reply, attempt: attempt + 1 };
    } catch (error) {
      failed(attempt + 1);
      if (!retry || attempt >= 5 || !url.startsWith(ENDPOINT)) throw new Error(safeText(runtime, String(error)));
    } finally { clearTimeout(timer); }
    await sleep(1000 * 2 ** attempt);
  }
}

async function runAgent(dir: string, procedure: string, runtime: RunRuntime): Promise<Agent> {
  const { conditions } = readRun(dir);
  const agent: Agent = { status: 'max_turns', model: conditions.model, modelVersion: null, provider: conditions.provider!, respondedProviders: [], turns: 0,
    startedAt: runtime.now().toISOString(), finishedAt: '', promptTokens: 0, outputTokens: 0, thinkingLevel: conditions.thinkingLevel ?? null,
    thoughtsTokens: 0, cost: null, badArguments: 0, emptyReplies: 0 };
  const save = (name: string, value: unknown) => writeFileSync(join(dir, name), safeText(runtime, JSON.stringify(value, null, 2)) + '\n');
  const log = (value: unknown) => appendFileSync(join(dir, 'agent-log.jsonl'), safeText(runtime, JSON.stringify(value)) + '\n');
  const messages: unknown[] = [{ role: 'system', content: `${procedure}\n\n${SETTINGS}` },
    { role: 'user', content: '次の研究プロトコルについて、手順書に従って検索式を作り、提出してください。\n\n'
      + readFileSync(join(dir, 'protocol.md'), 'utf8') }];
  const tools = [
    { type: 'function', function: { name: 'write_formula', description: '検索式の全文を書く',
      parameters: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] } } },
    { type: 'function', function: { name: 'tool', description: '手順書の道具を呼ぶ', parameters: { type: 'object', properties: {
      command: { type: 'string', enum: conditions.tools }, argument: { type: 'string' },
    }, required: ['command'] } } },
  ];
  let empty = false;
  try {
    for (let turn = 1; turn <= 60; turn++) {
      agent.turns = turn;
      const { reply, attempt } = await generate(ENDPOINT, {
        model: conditions.model, messages, tools, provider: { only: [conditions.provider], allow_fallbacks: false },
        ...(conditions.thinkingLevel === undefined ? {} : { reasoning: { effort: conditions.thinkingLevel } }), usage: { include: true },
      }, runtime, (attempt) => log({ turn, attempt, at: runtime.now().toISOString(), type: 'error', resultLength: 0 }));
      if (typeof reply.model === 'string') agent.modelVersion = safeText(runtime, reply.model);
      if (typeof reply.provider === 'string') {
        const provider = safeText(runtime, reply.provider);
        if (!agent.respondedProviders.includes(provider)) agent.respondedProviders.push(provider);
      }
      const usage = { promptTokens: tokens(reply.usage?.prompt_tokens), completionTokens: tokens(reply.usage?.completion_tokens),
        reasoningTokens: tokens(reply.usage?.completion_tokens_details?.reasoning_tokens), cost: costValue(reply.usage?.cost) };
      agent.promptTokens += usage.promptTokens; agent.outputTokens += usage.completionTokens; agent.thoughtsTokens += usage.reasoningTokens;
      if (usage.cost !== null) agent.cost = (agent.cost ?? 0) + usage.cost;
      const message = reply.choices[0]!.message;
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      const call = calls[0];
      const fn = object(call) && object(call.function) ? call.function : undefined;
      const name = typeof fn?.name === 'string' ? fn.name : undefined;
      const text = typeof message.content === 'string' ? message.content : '';
      let result = '', badArguments = false;
      let args: FunctionCall['args'] = {};
      try {
        if (calls.length) {
          try {
            if (!object(call) || typeof call.id !== 'string' || name === undefined || typeof fn?.arguments !== 'string') throw new Error('関数の形式が不正です');
            const parsed: unknown = JSON.parse(fn.arguments === '' ? '{}' : fn.arguments);
            if (!object(parsed)) throw new Error('引数はオブジェクトが必要です');
            args = parsed;
          } catch { badArguments = true; agent.badArguments++; }
          result = badArguments ? 'エラー: 引数が読めませんでした。JSON のオブジェクトで指定してください'
            : await callFunction({ name: name!, args }, dir, conditions.tools, runtime);
          if (calls.length > 1) result += '\n複数の関数が指定されたため、最初の 1 つだけ実行しました。';
          messages.push(message, ...calls.map((item, index) => ({ role: 'tool', tool_call_id: object(item) && typeof item.id === 'string' ? item.id : '',
            content: safeText(runtime, index === 0 ? result : '未実行: 関数は 1 回の応答で 1 つずつ呼んでください。'),
          })));
          empty = false;
        } else if (text) {
          writeFileSync(join(dir, 'final.txt'), safeText(runtime, text)); agent.status = 'completed';
        } else {
          agent.emptyReplies++;
          if (empty) { agent.status = 'completed'; agent.note = '応答が 2 回続けて空でした'; }
          else { empty = true; messages.push({ role: 'user', content: '応答が空でした。続けてください。' }); }
        }
      } finally {
        log({ turn, attempt, at: runtime.now().toISOString(), type: badArguments ? 'bad_arguments'
          : call ? (['write_formula', 'tool'].includes(name!) ? name : 'unknown') : text ? 'text' : 'empty',
          arguments: name === 'write_formula' ? { contentLength: typeof args.content === 'string' ? args.content.length : 0 }
            : name === 'tool' ? { command: conditions.tools.includes(args.command as Command) ? args.command : 'unknown',
              argumentLength: typeof args.argument === 'string' ? args.argument.length : 0 } : undefined,
          resultLength: result.length, usage });
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
  if ((conditions.runner ?? 'claude-subagent') !== 'openrouter-api') throw new Error('実行役が openrouter-api の版を指定してください');
  if (conditions.combine) throw new Error('束ねた版は実行できません');
  if (!runtime.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY が必要です');
  const procedure = procedureBody(readFileSync(join(runtime.harnessDir ?? resolve(__dirname, '../harness'), options.version, 'procedure.md'), 'utf8'));
  const reviews = targetReviews(options, runtime);
  const jobs = reviews.flatMap((review) => Array.from({ length: options.runsPerReview }, (_, i) => ({ review, runIndex: i + 1 })));
  const counts = { completed: 0, max_turns: 0, error: 0 };
  let skipped = 0, rebuilt = 0, executed = 0, promptTokens = 0, outputTokens = 0, thoughtsTokens = 0, cost = 0, badArguments = 0, emptyReplies = 0, next = 0;
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
      cost += agent.cost ?? 0; badArguments += agent.badArguments; emptyReplies += agent.emptyReplies;
    }
  }));
  for (const line of [`対象: ${jobs.length} 件`, `今回実行: ${executed} 件`, `済みで省略: ${skipped} 件`, `作り直し: ${rebuilt} 件`,
    `completed: ${counts.completed} 件`, `max_turns: ${counts.max_turns} 件`, `error: ${counts.error} 件`,
    `入力トークン: ${promptTokens}`, `出力トークン: ${outputTokens}`, `推論トークン: ${thoughtsTokens}`, `費用（USD）: ${cost.toFixed(4)}`,
    `引数が読めなかった応答: ${badArguments}`, `空の応答: ${emptyReplies}`]) runtime.stdout(safeText(runtime, line + '\n'));
  return counts.error ? 1 : 0;
}

export async function main(args: string[], runtime: RunRuntime = defaultRuntime()): Promise<number> {
  try { return await execute(args, runtime); }
  catch (error) { throw new Error(safeText(runtime, String(error))); }
}
if (require.main === module) {
  config();
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(redact(String(error), [process.env.OPENROUTER_API_KEY ?? '', process.env.NCBI_API_KEY ?? '']) + '\n'); process.exitCode = 1;
  });
}
