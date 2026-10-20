import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import ts from 'typescript';
import { getPromptVersion, PROMPT_VERSIONS } from './promptVersions';
import fixedHashes from './promptHashes.json';

const sources: Record<string, string | null> = {
  "draft_block": "blockDesigner",
  "draft_agent": "../agentDraft/procedure",
  "suggest_mesh": "meshSuggester",
  "expand_freeword": "freewordDesigner",
  "design_filter": "filterDesigner",
  "pick_boundary": "pickBoundaryCases",
  "pick_seed": "pickSeedCandidates",
  "design_specific_query": "designSpecificQuery",
  "expand_recall": "expandQueryForRecall",
  "interpret_result": "interpretResult",
  "extract_protocol": "extractProtocol",
  "improve_block": "improveBlock",
  "optimize_query": "optimizeQuery",
  "annotate_lost_sample": "annotateLostSample",
  "other": null
};

/** 定数の初期値のソースを固定し、置換式も含めて雛形の変更を検出する。 */
function templates(file: string, variant: string): string[] {
  // Windows の core.autocrlf=true では作業ツリーが CRLF になり、固定 SHA-256 と一致しなくなるため LF にそろえる。
  const text = readFileSync(join(__dirname, file + '.ts'), 'utf8').replace(/\r\n/g, '\n');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const values: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const name = node.name.text;
      if (name.includes('PROMPT') || name.startsWith('AGENT_DRAFT_')) {
        if (variant !== 'standard' || !name.includes('_AGENT_')) values.push(node.initializer.getText(source));
      }
    }
    if (file.endsWith('runAgentDraft') && ts.isFunctionDeclaration(node) && node.name?.text === 'initialMessage') values.push(node.getText(source));
    ts.forEachChild(node, visit);
  };
  visit(source);
  return values;
}

test('purpose ごとのプロンプト雛形の変更時は版を上げること', () => {
  const actual: Record<string, string> = {};
  for (const purpose of Object.keys(PROMPT_VERSIONS) as (keyof typeof PROMPT_VERSIONS)[]) {
    for (const provider of purpose === 'extract_protocol' ? ['anthropic', 'gemini'] as const : ['gemini'] as const) {
      const file = sources[purpose];
      const variant = purpose === 'extract_protocol' && provider !== 'anthropic' ? 'standard' : 'anthropic';
      const values = file ? templates(file, variant) : [];
      if (purpose === 'draft_agent') values.push(...templates('../agentDraft/runAgentDraft', variant));
      actual[purpose + '@' + getPromptVersion(purpose, provider)] = createHash('sha256').update(values.join('\n')).digest('hex');
    }
  }
  if (JSON.stringify(actual) !== JSON.stringify(fixedHashes)) {
    throw new Error('プロンプト雛形が変わりました。版を上げること。対応する固定 SHA-256 も更新してください。\n' + JSON.stringify(actual, null, 2));
  }
});
