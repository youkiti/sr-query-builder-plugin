import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from 'dotenv';
import { esearch } from '../../../src/lib/ncbi/eutils';
import { fetchMeshTreeNumbers, resolveMeshDescriptors } from '../../../src/lib/ncbi/mesh';
import { expandFormula } from '../../../src/features/validation/expandFormula';
import { capturedGold, redact, seedTitles } from '../../query-optimization-bench/ncbiEval';
import { COMMANDS, type Command } from './conditions';
import { requiredUnits } from './formulaUnits';
import { createDeps, isQueryRejection, type DepsOptions } from './ncbi';
import { readBudget, readRun, recordToolCall, writeJson, withRunLock, type LockOptions, type ToolResult } from './runDir';
import { validateFormulaMd } from './submission';
import { inspectTable, buildFormulaMd, rowQueries, rowContextQueries, type ConceptTable } from './conceptTable';

export interface Runtime {
  env: NodeJS.ProcessEnv; fetchImpl: typeof fetch; now: () => Date;
  stdout: (text: string) => void; stderr: (text: string) => void; sleep?: DepsOptions['sleep'];
  timeoutMs?: number;
  rateLimiter?: DepsOptions['rateLimiter'];
  lockOptions?: LockOptions;
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
  const result = await withRunLock(dir, async () => {
    const budget = readBudget(dir);
    const finish = (result: ToolResult, code: number, message: string): number => {
      recordToolCall(dir, budget, { at: now().toISOString(), command: safe(command),
        args: argument === undefined ? '引数なし' : command === 'mesh' ? `語の長さ: ${argument.length}` : run.conditions.table ? '表のファイル 1 件' : command === 'outside' ? '式ファイル 1 件・単位 1 件' : '式ファイル 1 件', result,
        remaining: { measurements: run.conditions.maxMeasurements - budget.measurements, submissions: run.conditions.maxSubmissions - budget.submissions } });
      (code === 0 ? stdout : stderr)(safe(message) + '\n');
      return code;
    };
    if (!COMMANDS.includes(command as Command) || !run.conditions.tools.includes(command as Command)) return finish('使えないコマンド', 2, 'この版では使えないコマンドです');
    let seedPmids: string[] = [];
    if (command === 'seeds') {
      if (!argument || args.length !== 4) return finish('検査不合格', 1, '式ファイルを 1 件指定してください');
      try {
        const value = JSON.parse(readFileSync(join(dir, 'seeds.json'), 'utf8')) as { pmids?: string[] } | null;
        if (!value || !Array.isArray(value.pmids) || value.pmids.some((pmid) => typeof pmid !== 'string' || !/^[1-9]\d*$/.test(pmid))
          || new Set(value.pmids).size !== value.pmids.length) throw new Error();
        seedPmids = value.pmids;
      } catch { return finish('測定失敗（結果不明）', 3, 'シードの記録を読み込めません。回数は消費していません'); }
      if (!seedPmids.length) return finish('成功', 0, 'シード論文はありません');
    }
    const measuring = ['count', 'mesh', 'titles', 'outside', 'seeds'].includes(command);
    if ((measuring && budget.measurements >= run.conditions.maxMeasurements)
      || (command === 'submit' && budget.submissions >= run.conditions.maxSubmissions)) return finish('上限超過', 2, '呼び出し回数の上限に達しています');
    let md = '';
    let table: ConceptTable | null = null;
    let tableText = '';
    let notes: string[] = [];
    let validated: ReturnType<typeof validateFormulaMd> | undefined;
    if (command !== 'mesh') {
      try {
        if (!argument || args.length !== (command === 'outside' ? 5 : 4)) throw new Error(command === 'outside' ? '式ファイルと単位の ID を 1 件ずつ指定してください' : '式ファイルを 1 件指定してください');
        md = readFileSync(argument, 'utf8');
        if (run.conditions.table) {
          tableText = md;
          const inspected = inspectTable(tableText);
          table = inspected.table;
          notes = inspected.report.notes;
          if (!table) validated = { ok: false, reasons: ['未対応の点:', ...inspected.report.blocking, ...(notes.length ? ['気づき:', ...notes] : [])] };
          else md = buildFormulaMd(table);
        }
        if (!validated) validated = validateFormulaMd(md);
      } catch (error) { validated = { ok: false, reasons: [command === 'seeds' ? '式ファイルを読み込めません' : String(error)] }; }
      if (!validated.ok) {
        if (command === 'submit') budget.submissions++;
        return finish('検査不合格', 1, command === 'seeds' ? '式の検査に通りませんでした' : validated.reasons.join('\n'));
      }
    }
    if (command === 'check') return finish('成功', 0, '検査に通りました' + (notes.length ? '\n\n気づき:\n' + notes.join('\n') : ''));
    try {
      const hitsLimit = run.conditions.table ? run.conditions.hitsLimit : undefined;
      const makeDeps = () => createDeps({ env, fetchImpl, cutoffDate: run.cutoffDate, sleep, timeoutMs: runtime.timeoutMs, rateLimiter: runtime.rateLimiter });
      if (command === 'submit' && validated?.ok) {
        const count = hitsLimit ? (await esearch(validated.query, makeDeps(), { retmax: 0 })).count : undefined;
        if (hitsLimit && count !== undefined && count > hitsLimit && !table?.largeResultReason?.trim()) {
          budget.submissions++;
          return finish('検査不合格', 1, `全体が ${count} 件で、目安の ${hitsLimit} 件を超えています。count で見直す点を確かめてください。見直しても超えるときは、largeResultReason に理由を書いて提出してください。`);
        }
        const number = budget.submissions + 1;
        mkdirSync(join(dir, 'submissions'), { recursive: true });
        writeFileSync(join(dir, 'submissions', `${number}.md`), safe(md), { flag: 'wx' });
        if (table) writeFileSync(join(dir, 'submissions', `${number}.table.json`), safe(tableText), { flag: 'wx' });
        writeJson(join(dir, 'submission.json'), { number, submittedAt: now().toISOString(), query: safe(validated.query) });
        budget.submissions++;
        return finish('成功', 0, `提出 ${number} を受け付けました` + (count !== undefined ? `（全体 ${count} 件）` : ''));
      }
      const deps = makeDeps();
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
        const count = (await esearch(validated.query, deps, { retmax: 0 })).count;
        const lines = [`全体: ${count} 件`];
        for (const block of validated.formula.blocks) lines.push(`#${block.id}: ${(await esearch(expandFormula(validated.formula, block.id), deps, { retmax: 0 })).count} 件`);
        const contributions: { concept: number; row: number; label: string; count: number }[] = [];
        const contexts = table && hitsLimit ? rowContextQueries(table) : [];
        if (table) for (const [i, row] of rowQueries(table).entries()) {
          const rowCount = (await esearch(row.query, deps, { retmax: 0 })).count;
          const contextCount = hitsLimit ? (await esearch(contexts[i]!.query, deps, { retmax: 0 })).count : undefined;
          lines.push(`#${row.concept} 行 ${row.row}（${row.kind === 'general' ? '総称' : '個別の名称'}: ${row.label}）: ${rowCount} 件` + (contextCount !== undefined ? `（式全体のうち ${contextCount} 件）` : ''));
          if (contextCount !== undefined) contributions.push({ ...row, count: contextCount });
        }
        if (table && hitsLimit && count > hitsLimit) {
          lines.push('', `件数の見直し: 全体が ${count} 件で、目安の ${hitsLimit} 件を超えています。`);
          if (table.concepts.length === 1) lines.push('- 概念が 1 個だけです。このレビューを区別する中心の概念がもう 1 つ無いか、手順 1 に戻って確かめてください。');
          for (const row of contributions.filter((row) => row.count >= count / 2).sort((a, b) => b.count - a.count).slice(0, 5)) {
            lines.push(`- #${row.concept} 行 ${row.row}（${row.label}）が、式全体の ${Math.round(row.count / count * 100)}% を持ち込んでいます。その概念に属さない文献まで拾う広すぎる語（一般的な 1 語、類が広すぎる語の組、短すぎる語幹）が無いか確かめてください。その概念を正しく指す語や、個別の名称の行は削らないでください。`);
          }
          lines.push('- 見直しても超えるときは、largeResultReason に「これ以上絞ると、どういう適格な研究を落とすか」を書いて提出してください。');
        }
        message = lines.join('\n');
      } else if (validated?.ok && command === 'seeds') {
        const captured = new Set(await capturedGold(validated.query, seedPmids, deps));
        const blocks: { id: string; captured: Set<string> }[] = [];
        for (const block of validated.formula.blocks.filter((block) => !block.isCombination)) {
          blocks.push({ id: block.id, captured: new Set(await capturedGold(expandFormula(validated.formula, block.id), seedPmids, deps)) });
        }
        message = seedPmids.map((pmid, i) => {
          const prefix = `シード ${i + 1}（${pmid}）: `;
          if (captured.has(pmid)) return prefix + '式に入っています';
          const missed = blocks.filter((block) => !block.captured.has(pmid)).map((block) => `#${block.id}`);
          return prefix + `式に入っていません。当てはまらない行: ${missed.join(', ') || 'なし（行の組み合わせで外れています）'}`;
        }).join('\n');
      } else if (validated?.ok && command === 'titles') {
        const result = await esearch(validated.query, deps, { retmax: 10 });
        message = result.pmids.length ? (await seedTitles(result.pmids, deps)).map((row, i) => `${i + 1}. ${row.title}`).join('\n') : '0 件です';
      } else if (validated?.ok && command === 'outside') {
        const { units, undetermined } = requiredUnits(validated.formula);
        if (undetermined) return finish('検査不合格', 1, 'この式の形では使えません（最後の行を、ブロックの AND 結合にしてください）');
        const target = units.find((unit) => unit.id === args[4]);
        if (!target) return finish('検査不合格', 1, `指定した単位がありません。使える ID: ${units.filter((unit) => !unit.negative).map((unit) => unit.id).join(', ')}`);
        if (target.negative) return finish('検査不合格', 1, '否定の単位（NOT の右側）には使えません');
        const remaining = units.filter((unit) => unit.id !== target.id);
        if (!remaining.some((unit) => !unit.negative)) return finish('検査不合格', 1, '指定した単位のほかに肯定の単位がありません');
        const query = remaining.filter((unit) => !unit.negative).map((unit) => `(${unit.expression})`).join(' AND ')
          + remaining.filter((unit) => unit.negative).map((unit) => ` NOT (${unit.expression})`).join('')
          + ` NOT (${target.expression})`;
        const result = await esearch(query, deps, { retmax: 15, sort: 'relevance' });
        if (result.pmids.length !== Math.min(result.count, 15) || new Set(result.pmids).size !== result.pmids.length) throw new Error('検索結果の一覧が不完全です');
        const titles = result.count ? (await seedTitles(result.pmids, deps)).map((row, i) => `${i + 1}. ${row.title}`).join('\n') : '0 件です';
        message = `#${target.id} を外すと拾えるのに、#${target.id} があるために入っていない文献: ${result.count} 件\n${titles}`;
      } else throw new Error('コマンドの引数が不正です');
      budget.measurements++;
      return finish('成功', 0, message);
    } catch (error) {
      if (['count', 'titles', 'outside', 'seeds'].includes(command) && isQueryRejection(error)) return finish('検査不合格', 1, command === 'seeds' ? '検索式が拒否されました' : (error as Error).message);
      if (command === 'outside' || command === 'seeds') return finish('測定失敗（結果不明）', 3, '測定に失敗しました。回数は消費していません');
      return finish('測定失敗（結果不明）', 3, `測定に失敗しました。回数は消費していません\n${safe(String(error))}`);
    }
  }, runtime.lockOptions);
  if (result === null) { stderr('同じ実行フォルダで別の呼び出しが実行中です。回数は消費していません\n'); return 3; }
  return result;
}

if (require.main === module) {
  config();
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(redact(String(error), [process.env.NCBI_API_KEY ?? '']) + '\n'); process.exitCode = 1;
  });
}
