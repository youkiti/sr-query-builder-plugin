import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from 'dotenv';
import { createProvider, withRetry, type ChatResponse, type LLMProvider } from '../../../src/lib/llm';
import { extractProtocol } from '../../../src/features/formula/skills/extractProtocol';
import { SkillResponseError } from '../../../src/features/formula/skills/parseSkillJson';
import { buildSeedContext, generateDraftFormula } from '../../../src/app/services/draftService';
import { parseManualProtocol } from '../../../src/features/protocol';
import { parsePubmedFormulaMd } from '../../../src/lib/search-formula-md';
import { expandFormula } from '../../../src/features/validation/expandFormula';
import { esearch } from '../../../src/lib/ncbi/eutils';
import { fetchMeshTreeNumbers, resolveMeshDescriptors } from '../../../src/lib/ncbi/mesh';
import { TokenBucket } from '../../../src/lib/ncbi/rateLimit';
import { redact } from '../../query-optimization-bench/ncbiEval';
import { casesDir } from './cases';
import { loadConditions } from './conditions';
import { parseOptions } from './geminiRun';
import { createDeps, ncbiRate } from './ncbi';
import { createRun, readRun, recordToolCall, runPath, type ToolResult } from './runDir';
import { targetReviews, type RunRuntime } from './startRuns';
import { defaultRuntime } from './tool';

type Status = 'completed' | 'no_submission' | 'extraction_failed' | 'error';
interface Agent {
  status: Status; model: string; respondedModels: string[]; effort: 'medium';
  extractionCalls: number; generationCalls: number; promptTokens: number; outputTokens: number;
  startedAt: string; finishedAt: string; note?: string;
}
// 保存する式や抽出結果には API キーの除去だけを掛ける（URL などの伏せ字で検索式を書き換えない）。
const redactKeys = (runtime: RunRuntime, text: string) => redact(text, [runtime.env.ANTHROPIC_API_KEY ?? '', runtime.env.NCBI_API_KEY ?? '']);
const safeText = (runtime: RunRuntime, text: string) => redactKeys(runtime, text)
  .replace(/https?:\/\/[^\s"<>]+/gi, '[URL]')
  .replace(/(?:authorization|x-api-key|api-key|headers?)\s*[:=][^\r\n]*/gi, '[REDACTED]');

async function runAgent(dir: string, runtime: RunRuntime): Promise<Agent> {
  const run = readRun(dir);
  const agent: Agent = { status: 'error', model: run.conditions.model, respondedModels: [], effort: 'medium',
    extractionCalls: 0, generationCalls: 0, promptTokens: 0, outputTokens: 0, startedAt: runtime.now().toISOString(), finishedAt: '' };
  const save = (name: string, value: unknown) => writeFileSync(join(dir, name), JSON.stringify(value,
    (key, item: unknown) => typeof item === 'string' ? (key === 'note' ? safeText : redactKeys)(runtime, item) : item, 2) + '\n');
  let extracting = true;
  let measurementFailed = false;
  try {
    const retried = withRetry(createProvider({ provider: 'anthropic', apiKey: runtime.env.ANTHROPIC_API_KEY!,
      model: run.conditions.model, effort: 'medium', fetch: runtime.fetchImpl }), {
      createSignal: () => AbortSignal.timeout(300_000), sleep: runtime.sleep, maxAttempts: 6,
    });
    const counted = async <T extends ChatResponse>(call: () => Promise<T>): Promise<T> => {
      if (extracting) agent.extractionCalls++; else agent.generationCalls++;
      const reply = await call();
      agent.promptTokens += reply.tokensIn ?? 0; agent.outputTokens += reply.tokensOut ?? 0;
      const model = reply.raw && typeof reply.raw === 'object' && 'model' in reply.raw ? reply.raw.model : undefined;
      if (typeof model === 'string' && !agent.respondedModels.includes(model)) agent.respondedModels.push(model);
      return reply;
    };
    const provider: LLMProvider = { providerId: 'anthropic', model: run.conditions.model,
      chat: (messages, options) => counted(() => retried.chat(messages, options)),
      chatWithTools: (system, messages, tools, options) => counted(() => retried.chatWithTools!(system, messages, tools, options)),
    };
    const parsed = parseManualProtocol(readFileSync(join(dir, 'protocol.md'), 'utf8'));
    const extract = async () => {
      for (let attempt = 1; ; attempt++) {
        try { return await extractProtocol(parsed.plainText, provider); }
        catch (error) { if (!(error instanceof SkillResponseError) || attempt >= 3) throw error; }
      }
    };
    const draft = await extract();
    save('extraction.json', draft);
    extracting = false;
    const deps = createDeps({ env: runtime.env, fetchImpl: runtime.fetchImpl, cutoffDate: run.cutoffDate,
      sleep: runtime.sleep, timeoutMs: runtime.timeoutMs, rateLimiter: runtime.rateLimiter });
    let submissions = 0;
    const result = await generateDraftFormula({
      protocol: { frameworkType: draft.frameworkType, researchQuestion: draft.researchQuestion,
        inclusionCriteria: draft.inclusionCriteria, exclusionCriteria: draft.exclusionCriteria, studyDesign: draft.studyDesign,
        sourceType: parsed.sourceType, sourceFilename: parsed.sourceFilename === '' ? null : parsed.sourceFilename,
        rawTextRef: null, rawTextPreview: parsed.preview, rawTextInline: parsed.plainText },
      blocks: { blocks: draft.blocks.map((block) => ({ ...block, aiGenerated: true, note: '' })),
        combinationExpression: draft.combinationExpression,
        ...(draft.suggestedFilterIds !== undefined ? { selectedFilterIds: draft.suggestedFilterIds, filterSelectionSource: 'ai' as const } : {}) },
      seedContext: buildSeedContext([]),
    }, {
      llmFactory: { providerId: 'anthropic', model: run.conditions.model, forPurpose: () => provider },
      countBlockHits: async (query) => (await esearch(query, deps, { retmax: 0 })).count,
      resolveMeshDescriptors: (terms) => resolveMeshDescriptors(terms, deps),
      fetchMeshTreeNumbers: (terms) => fetchMeshTreeNumbers(terms, deps),
      onProgress: (progress) => {
        const step = progress.agent;
        if (progress.step !== 'agent' || !step) return;
        submissions = step.submissions;
        const command = step.lastCommand;
        if (!command || command === 'write_formula') return;
        const results: Record<number, ToolResult> = { 0: '成功', 1: '検査不合格', 2: '上限超過', 3: '測定失敗（結果不明）' };
        recordToolCall(dir, { measurements: step.measurements, submissions }, { at: runtime.now().toISOString(), command,
          args: command === 'mesh' ? '語 1 件' : '式ファイル 1 件', result: results[step.lastExitCode ?? 1]!,
          remaining: { measurements: step.maxMeasurements - step.measurements, submissions: step.maxSubmissions - submissions } });
        if (step.lastExitCode === 3) measurementFailed = true;
      },
    });
    mkdirSync(join(dir, 'submissions'), { recursive: true });
    writeFileSync(join(dir, 'submissions', `${submissions}.md`), redactKeys(runtime, result.markdown));
    save('submission.json', { number: submissions, submittedAt: runtime.now().toISOString(),
      query: expandFormula(parsePubmedFormulaMd(result.markdown)) });
    agent.status = 'completed';
  } catch (error) {
    agent.status = extracting && error instanceof SkillResponseError ? 'extraction_failed'
      // 測定が失敗した実行で提出に至らなかったときは、通信の失敗が原因かもしれないので、作り直しの対象に残す。
      : !extracting && !measurementFailed && error instanceof Error && error.message.startsWith('AI が検索式を提出できませんでした') ? 'no_submission' : 'error';
    agent.note = safeText(runtime, String(error));
  }
  agent.finishedAt = runtime.now().toISOString();
  save('agent.json', agent);
  return agent;
}

async function execute(args: string[], runtime: RunRuntime): Promise<number> {
  const options = parseOptions(args);
  const conditions = loadConditions(options.version, runtime.harnessDir);
  if (conditions.runner !== 'app-anthropic') throw new Error('実行役が app-anthropic の版を指定してください');
  if (!runtime.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY が必要です');
  const reviews = targetReviews(options, runtime);
  const jobs = reviews.flatMap((review) => Array.from({ length: options.runsPerReview }, (_, i) => ({ review, runIndex: i + 1 })));
  const counts = { completed: 0, no_submission: 0, extraction_failed: 0, error: 0 };
  let skipped = 0, rebuilt = 0, executed = 0, promptTokens = 0, outputTokens = 0, next = 0;
  const toolRuntime = { ...runtime, rateLimiter: new TokenBucket({ ratePerSecond: ncbiRate(runtime.env), capacity: 1,
    now: () => runtime.now().getTime(), sleep: runtime.sleep }) };
  await Promise.all(Array.from({ length: options.concurrency }, async () => {
    while (next < jobs.length) {
      const { review, runIndex } = jobs[next++]!;
      const dir = runPath(options.root, options.version, review.pmcid, runIndex);
      if (existsSync(dir)) {
        let status: unknown;
        try { status = (JSON.parse(readFileSync(join(dir, 'agent.json'), 'utf8')) as Agent).status; } catch { status = 'error'; }
        if (status === 'completed' || status === 'no_submission' || status === 'extraction_failed') { skipped++; continue; }
        let stamp = runtime.now().getTime();
        let backup: string;
        do { backup = `${dir}.failed-${new Date(stamp).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}`; stamp += 1000; }
        while (existsSync(backup));
        renameSync(dir, backup); rebuilt++;
      }
      createRun({ root: options.root, version: options.version, pmcid: review.pmcid, runIndex, cutoffDate: review.cutoffDate,
        protocolPath: join(runtime.casesDir ?? casesDir(), review.pmcid, 'protocol.md'), conditions, now: runtime.now });
      executed++;
      const agent = await runAgent(dir, toolRuntime);
      counts[agent.status]++; promptTokens += agent.promptTokens; outputTokens += agent.outputTokens;
    }
  }));
  for (const line of [`対象: ${jobs.length} 件`, `今回実行: ${executed} 件`, `済みで省略: ${skipped} 件`, `作り直し: ${rebuilt} 件`,
    ...Object.entries(counts).map(([status, count]) => `${status}: ${count} 件`), `入力トークン: ${promptTokens}`, `出力トークン: ${outputTokens}`]) runtime.stdout(safeText(runtime, line + '\n'));
  return counts.error ? 1 : 0;
}

export async function main(args: string[], runtime: RunRuntime = defaultRuntime()): Promise<number> {
  try { return await execute(args, runtime); }
  catch (error) { throw new Error(safeText(runtime, String(error))); }
}
if (require.main === module) {
  config();
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(safeText(defaultRuntime(), String(error)) + '\n'); process.exitCode = 1;
  });
}
