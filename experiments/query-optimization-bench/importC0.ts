import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parsePubmedFormulaMd } from '../../src/lib/search-formula-md';
import { expandFormula } from '../../src/features/validation/expandFormula';
import { freezeC0, parseFreezeArgs, type FreezeArgs } from './freezeC0';
import { prepareC0Context, finalizeC0Content, type GenerateC0Input, type GenerateC0Deps } from './c0Generation';
import type { C0Content } from './c0Artifact';
import { FIXTURES } from './prepare';
import { RESULTS } from './run';
import { redact } from './ncbiEval';

export interface ImportArgs extends FreezeArgs {
  formulaPath: string;
}

export function parseImportArgs(args: string[]): ImportArgs {
  const freezeArgs: string[] = [];
  let formulaPath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--formula') {
      if (formulaPath !== undefined || !args[i + 1] || args[i + 1]!.startsWith('--')) {
        throw new Error('--formula には検索式 Markdown のパスを 1 回だけ指定してください');
      }
      formulaPath = args[++i];
    } else freezeArgs.push(args[i]!);
  }
  if (!formulaPath) throw new Error('--formula には検索式 Markdown のパスを指定してください');
  return { ...parseFreezeArgs(freezeArgs), formulaPath };
}

/** 既存パーサと参照展開によるローカル検証。LLM の抽出結果との比較・実測は本実行で行う。 */
function parseImportFormula(markdown: string) {
  const formula = parsePubmedFormulaMd(markdown);
  if (!formula.blocks.some((block) => !block.isCombination)) throw new Error('取り込む検索式に非結合ブロックがありません');
  for (const block of formula.blocks) expandFormula(formula, block.id);
  return formula;
}

export async function importC0Content(input: GenerateC0Input & { formulaMd: string; formulaPath: string },
  deps: GenerateC0Deps): Promise<C0Content> {
  const formula = parseImportFormula(input.formulaMd);
  const context = await prepareC0Context(input, deps);
  const blockCount = formula.blocks.filter((block) => !block.isCombination).length;
  if (blockCount !== context.blocks.blocks.length) {
    throw new Error(`取り込んだ式の非結合ブロック数（${blockCount}）とプロトコルから抽出した blocks.blocks の数（${context.blocks.blocks.length}）が一致しません`);
  }
  const content = await finalizeC0Content(input, deps, context, { formula, markdown: input.formulaMd });
  return { ...content, source: 'import', sourceFilename: basename(input.formulaPath) };
}

export async function main(args = process.argv.slice(2), fixturesDir = FIXTURES, resultsDir = RESULTS): Promise<void> {
  const options = parseImportArgs(args);
  const formulaMd = readFileSync(options.formulaPath, 'utf8');
  const formula = parseImportFormula(formulaMd);
  await freezeC0(options, fixturesDir, resultsDir, (input, deps) => importC0Content({ ...input, formulaMd, formulaPath: options.formulaPath }, deps));
  if (options.dryRun) {
    process.stdout.write(`検索式 Markdown のパース・参照展開 OK（非結合ブロック数=${formula.blocks.filter((block) => !block.isCombination).length}）。`
      + 'プロトコル抽出とのブロック数照合・NCBI 実測は未実施（API calls=0）\n');
  }
}

if (require.main === module) void main().catch((err: unknown) => {
  process.stderr.write(`${redact(err instanceof Error ? err.message : String(err), [process.env.GEMINI_API_KEY ?? '', process.env.NCBI_API_KEY ?? ''])}\n`);
  process.exitCode = 1;
});
