import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from 'dotenv';
import { esearch } from '../../../src/lib/ncbi/eutils';
import { fetchMeshTreeNumbers, resolveMeshDescriptors } from '../../../src/lib/ncbi/mesh';
import { expandFormula } from '../../../src/features/validation/expandFormula';
import { redact, seedTitles } from '../../query-optimization-bench/ncbiEval';
import { COMMANDS, type Command } from './conditions';
import { createDeps, type DepsOptions } from './ncbi';
import { readBudget, readRun, recordToolCall, writeJson, type ToolResult } from './runDir';
import { validateFormulaMd } from './submission';

export interface Runtime {
  env: NodeJS.ProcessEnv; fetchImpl: typeof fetch; now: () => Date;
  stdout: (text: string) => void; stderr: (text: string) => void; sleep?: DepsOptions['sleep'];
  timeoutMs?: number;
}
export const defaultRuntime = (): Runtime => ({ env: process.env, fetchImpl: globalThis.fetch, now: () => new Date(),
  stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text) });

export async function main(args: string[], runtime: Runtime = defaultRuntime()): Promise<number> {
  const { env, fetchImpl, now, stdout, stderr, sleep } = runtime;
  const safe = (text: string) => redact(text, [env.NCBI_API_KEY ?? '']);
  if (args[0] !== '--run' || !args[1]) throw new Error('--run に実行フォルダが必要です');
  const dir = args[1];
  const command = args[2] ?? '';
  const argument = args[3];
  const run = readRun(dir);
  const budget = readBudget(dir);
  const finish = (result: ToolResult, code: number, message: string): number => {
    recordToolCall(dir, budget, { at: now().toISOString(), command: safe(command),
      args: argument === undefined ? '引数なし' : command === 'mesh' ? `語の長さ: ${argument.length}` : '式ファイル 1 件', result,
      remaining: { measurements: run.conditions.maxMeasurements - budget.measurements, submissions: run.conditions.maxSubmissions - budget.submissions } });
    (code === 0 ? stdout : stderr)(safe(message) + '\n');
    return code;
  };
  if (!COMMANDS.includes(command as Command) || !run.conditions.tools.includes(command as Command)) return finish('使えないコマンド', 2, 'この版では使えないコマンドです');
  const measuring = ['count', 'mesh', 'titles'].includes(command);
  if ((measuring && budget.measurements >= run.conditions.maxMeasurements)
    || (command === 'submit' && budget.submissions >= run.conditions.maxSubmissions)) return finish('上限超過', 2, '呼び出し回数の上限に達しています');
  let md = '';
  let validated: ReturnType<typeof validateFormulaMd> | undefined;
  if (command !== 'mesh') {
    try {
      if (!argument || args.length !== 4) throw new Error('式ファイルを 1 件指定してください');
      md = readFileSync(argument, 'utf8');
      validated = validateFormulaMd(md);
    } catch (error) { validated = { ok: false, reasons: [String(error)] }; }
    if (!validated.ok) {
      if (command === 'submit') budget.submissions++;
      return finish('検査不合格', 1, validated.reasons.join('\n'));
    }
  }
  if (command === 'check') return finish('成功', 0, '検査に通りました');
  try {
    if (command === 'submit' && validated?.ok) {
      const number = budget.submissions + 1;
      mkdirSync(join(dir, 'submissions'), { recursive: true });
      writeFileSync(join(dir, 'submissions', `${number}.md`), safe(md), { flag: 'wx' });
      writeJson(join(dir, 'submission.json'), { number, submittedAt: now().toISOString(), query: safe(validated.query) });
      budget.submissions++;
      return finish('成功', 0, `提出 ${number} を受け付けました`);
    }
    const deps = createDeps({ env, fetchImpl, cutoffDate: run.cutoffDate, sleep, timeoutMs: runtime.timeoutMs });
    let message: string;
    if (command === 'mesh') {
      if (!argument?.trim() || args.length !== 4) throw new Error('MeSH の語を 1 つ指定してください');
      const term = argument.trim();
      const resolution = (await resolveMeshDescriptors([term], deps)).get(term);
      if (!resolution || resolution.status === 'unknown') throw new Error('MeSH の結果が不明です');
      if (resolution.status === 'missing') message = '見出しは見つかりませんでした';
      else {
        const lookup = await fetchMeshTreeNumbers(resolution.headings, deps);
        message = resolution.headings.map((heading) => `正式な見出し: ${heading}\ntree number: ${lookup.trees.get(heading)?.join(', ') ?? lookup.reasons.get(heading) ?? 'なし'}`).join('\n');
      }
    } else if (validated?.ok && command === 'count') {
      const lines = [`全体: ${(await esearch(validated.query, deps, { retmax: 0 })).count} 件`];
      for (const block of validated.formula.blocks) lines.push(`#${block.id}: ${(await esearch(expandFormula(validated.formula, block.id), deps, { retmax: 0 })).count} 件`);
      message = lines.join('\n');
    } else if (validated?.ok && command === 'titles') {
      const result = await esearch(validated.query, deps, { retmax: 10 });
      message = result.pmids.length ? (await seedTitles(result.pmids, deps)).map((row, i) => `${i + 1}. ${row.title}`).join('\n') : '0 件です';
    } else throw new Error('コマンドの引数が不正です');
    budget.measurements++;
    return finish('成功', 0, message);
  } catch (error) {
    return finish('測定失敗（結果不明）', 3, `測定に失敗しました。回数は消費していません\n${safe(String(error))}`);
  }
}

if (require.main === module) {
  config();
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(redact(String(error), [process.env.NCBI_API_KEY ?? '']) + '\n'); process.exitCode = 1;
  });
}
