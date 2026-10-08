import { renderPromptTemplate } from '../skills/renderPromptTemplate';
import { AGENT_DRAFT_PROCEDURE, AGENT_DRAFT_SETTINGS } from './procedure';

test('手順書と関数呼び出しの設定を保持し、上限を埋められる', () => {
  expect(AGENT_DRAFT_PROCEDURE).toContain('### 3. ブロックごとに MeSH 見出しを選ぶ');
  expect(AGENT_DRAFT_PROCEDURE).toContain('### 6. 確かめて提出する');
  expect(AGENT_DRAFT_PROCEDURE).toContain('## PubMed/MEDLINE\n\n```\n#1');
  expect(AGENT_DRAFT_SETTINGS).toContain('- 関数は 1 回の応答で 1 つずつ呼んでください。');
  expect(AGENT_DRAFT_SETTINGS).toContain('write_formula(content="...")');
  const rendered = renderPromptTemplate(AGENT_DRAFT_PROCEDURE, { MAX_MEASUREMENTS: '7', MAX_SUBMISSIONS: '2' });
  expect(rendered + AGENT_DRAFT_SETTINGS).not.toContain('{{');
  expect(rendered).toContain('合わせて 7 回まで');
  expect(rendered).toContain('`submit` は 2 回まで');
});
