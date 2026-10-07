import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { redact } from '../../query-optimization-bench/ncbiEval';
import { loadConditions } from './conditions';
import { procedureBody } from './leakCheck';
import { runPath } from './runDir';
import { parseRunOptions, targetReviews, type RunRuntime } from './startRuns';
import { defaultRuntime } from './tool';

const slash = (path: string): string => resolve(path).replace(/\\/g, '/');
const quoted = (text: string): string => '"' + text.replace(/[\\"$`]/g, '\\$&') + '"';
export function main(args: string[], runtime: RunRuntime = defaultRuntime()): number {
  const rest: string[] = [];
  const extra = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (key === '--env-file' || key === '--rps') {
      if (extra.has(key) || !args[i + 1] || args[i + 1]!.startsWith('--')) throw new Error('実行引数が不正です');
      extra.set(key, args[++i]!);
    } else rest.push(key);
  }
  const options = parseRunOptions(rest, '--runs');
  const envFile = extra.get('--env-file');
  const rps = Number(extra.get('--rps'));
  if (!Number.isFinite(rps) || rps <= 0 || rps > 10) throw new Error('--rps は 0 より大きく 10 以下にしてください');
  if (!envFile || !isAbsolute(envFile) || !existsSync(envFile) || !statSync(envFile).isFile()) throw new Error('--env-file に存在するファイルの絶対パスが必要です');
  const conditions = loadConditions(options.version, runtime.harnessDir);
  if (conditions.seeds || conditions.runner === 'gemini-api') throw new Error('この版には使えません');
  const dirs = targetReviews(options, runtime).flatMap((review) => Array.from({ length: options.runsPerReview }, (_, i) => slash(runPath(options.root, options.version, review.pmcid, i + 1))));
  for (const dir of dirs) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error('実行フォルダがありません');
    if (['prompt.txt', 'tool.sh'].some((file) => existsSync(join(dir, file)))) throw new Error('prompt.txt または tool.sh が既にあります');
  }
  const procedure = procedureBody(readFileSync(join(runtime.harnessDir ?? resolve(__dirname, '../harness'), options.version, 'procedure.md'), 'utf8')).trim();
  const root = slash(resolve(__dirname, '../../..'));
  const file = conditions.table ? 'table.json' : 'formula.md';
  const kind = conditions.table ? '表のファイル' : '検索式ファイル';
  const dotenv = `${root}/node_modules/dotenv/config`;
  const nodeOptions = `--require ${/\s/.test(dotenv) ? JSON.stringify(dotenv) : dotenv}`;
  for (const dir of dirs) {
    const prompt = procedure + `\n\n## この作業の設定\n\n- 作業フォルダ: \`${dir}\`\n- \`TOOL\` は \`bash "${dir}/tool.sh"\` です。例: \`bash "${dir}/tool.sh" count ${file}\`、\`bash "${dir}/tool.sh" mesh "語"\`。\n- ${kind}は作業フォルダに \`${file}\` という名前で書いてください（道具には \`${file}\` とだけ渡せば届きます）。\n- 読んでよいファイルは、作業フォルダの \`protocol.md\` と、あなたが書いた \`${file}\` だけです。\`tool.sh\` の中身や、作業フォルダの外は読まないでください。\n- コマンドは 1 つずつ実行してください（同時に複数実行しない）。\`count\` は数分かかることがあります。タイムアウトを 10 分にして実行してください。\n- 道具が「測定に失敗しました」と返したら、少し待って同じコマンドをもう一度だけ試してください。\n`;
    const script = `#!/bin/bash\n# 道具の入口。作業フォルダへ移動してから呼ぶので、ファイルは相対パスで指定できる。\ncd ${quoted(dir)} || exit 9\nDOTENV_CONFIG_PATH=${quoted(slash(envFile))} NODE_OPTIONS=${quoted(nodeOptions)} P2F_NCBI_RPS=${rps} PYTHONUTF8=1 \\\n  node ${quoted(`${root}/node_modules/tsx/dist/cli.mjs`)} ${quoted(`${root}/experiments/protocol-to-formula-loop/src/tool.ts`)} --run ${quoted(dir)} "$@"\n`;
    writeFileSync(join(dir, 'prompt.txt'), prompt, { flag: 'wx' });
    writeFileSync(join(dir, 'tool.sh'), script, { flag: 'wx' });
  }
  runtime.stdout(`作成: ${dirs.length} 件\n`);
  return 0;
}
if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(redact(String(error), [process.env.NCBI_API_KEY ?? '']) + '\n'); process.exitCode = 1; }
}
