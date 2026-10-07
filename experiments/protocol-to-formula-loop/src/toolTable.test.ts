/** @jest-environment node */
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFormulaMd, rowQueries, type ConceptTable } from './conceptTable';
import { loadConditions } from './conditions';
import { createRun, readBudget } from './runDir';
import { validateFormulaMd } from './submission';
import { main, type Runtime } from './tool';

function setup(tableMode = true) {
  const root = mkdtempSync(join(tmpdir(), 'p2f-table-'));
  const file = join(root, tableMode ? 'table.json' : 'formula.md');
  const table: ConceptTable = { concepts: [{ name: '治療', rows: [
    { kind: 'general', label: '総称', mesh: ['Heading'], terms: ['alpha therapy'] },
    { kind: 'specific', label: '名称', mesh: [], terms: ['word'] },
  ] }], rctFilter: true, dateRange: { from: '2000', to: '2020' } };
  writeFileSync(file, tableMode ? JSON.stringify(table, null, 2) : buildFormulaMd(table));
  const conditions = loadConditions(tableMode ? 'v11' : 'v1');
  const now = () => new Date('2026-01-01T00:00:00Z');
  const dir = createRun({ root, version: conditions.version, pmcid: 'PMC0000001', runIndex: 1, cutoffDate: '2020-01-31', protocolPath: file, conditions, now });
  const runtime: Runtime = { env: { NCBI_API_KEY: 'FAKE_SECRET', P2F_NCBI_RPS: '100000' }, now,
    stdout: jest.fn(), stderr: jest.fn(), sleep: async () => undefined,
    fetchImpl: jest.fn(async () => { throw new Error('想定外の通信'); }) };
  const call = (command: string) => main(['--run', dir, command, file], runtime);
  return { dir, file, table, runtime, call };
}
test('表の check は気づきを返し、通信も予算消費もしない', async () => {
  const s = setup();
  expect(await s.call('check')).toBe(0);
  expect(s.runtime.stdout).toHaveBeenCalledWith(expect.stringContaining('検査に通りました\n\n気づき:\n概念 1（治療）'));
  expect(readBudget(s.dir)).toEqual({ measurements: 0, submissions: 0 });
  expect(s.runtime.fetchImpl).not.toHaveBeenCalled();
  expect(JSON.parse(readFileSync(join(s.dir, 'tool-log.jsonl'), 'utf8'))).toMatchObject({ args: '表のファイル 1 件', result: '成功' });
});
test('未対応のある表の check と submit を拒否し、提出だけ１回消費する', async () => {
  const s = setup();
  s.table.concepts[0]!.rows.pop();
  writeFileSync(s.file, JSON.stringify(s.table));
  expect(await s.call('check')).toBe(1);
  expect(readBudget(s.dir)).toEqual({ measurements: 0, submissions: 0 });
  expect(s.runtime.stderr).toHaveBeenCalledWith(expect.stringMatching(/未対応の点:\n概念 1（治療）.*\n気づき:/));
  expect(await s.call('submit')).toBe(1);
  expect(readBudget(s.dir)).toEqual({ measurements: 0, submissions: 1 });
  expect(existsSync(join(s.dir, 'submission.json'))).toBe(false);
  expect(s.runtime.fetchImpl).not.toHaveBeenCalled();
});
test('提出時に表の原文・組んだ式・従来の項目だけの提出記録を保存する', async () => {
  const s = setup();
  expect(await s.call('submit')).toBe(0);
  expect(readdirSync(join(s.dir, 'submissions')).sort()).toEqual(['1.md', '1.table.json']);
  expect(readFileSync(join(s.dir, 'submissions/1.table.json'), 'utf8')).toBe(readFileSync(s.file, 'utf8'));
  expect(readFileSync(join(s.dir, 'submissions/1.md'), 'utf8')).toBe(buildFormulaMd(s.table));
  const validated = validateFormulaMd(buildFormulaMd(s.table));
  if (!validated.ok) throw new Error('式の検査に失敗しました');
  expect(JSON.parse(readFileSync(join(s.dir, 'submission.json'), 'utf8'))).toEqual({ number: 1, submittedAt: '2026-01-01T00:00:00.000Z', query: validated.query });
  expect(readBudget(s.dir)).toEqual({ measurements: 0, submissions: 1 });
});
test('表の保存は既存ファイルを上書きせず、秘密の文字列を伏せる', async () => {
  const s = setup();
  s.table.concepts[0]!.name = 'FAKE_SECRET';
  writeFileSync(s.file, JSON.stringify(s.table));
  expect(await s.call('submit')).toBe(0);
  expect(readFileSync(join(s.dir, 'submissions/1.table.json'), 'utf8')).not.toContain('FAKE_SECRET');
  writeFileSync(join(s.dir, 'submissions/2.table.json'), '先の記録');
  expect(await s.call('submit')).toBe(3);
  expect(readFileSync(join(s.dir, 'submissions/2.table.json'), 'utf8')).toBe('先の記録');
});
test('count は従来の出力に行別件数を加え、測定１回だけ消費する', async () => {
  const s = setup();
  const queries: string[] = [];
  s.runtime.fetchImpl = jest.fn(async (input, init) => {
    const url = new URL(String(input));
    if (!url.pathname.endsWith('/esearch.fcgi')) throw new Error('想定外の通信');
    const params = init?.method === 'POST' ? new URLSearchParams(String(init.body)) : url.searchParams;
    expect(Object.fromEntries(params)).toMatchObject({ db: 'pubmed', datetype: 'edat', mindate: '1800/01/01', maxdate: '2020/01/31', retmax: '0' });
    queries.push(params.get('term')!);
    return new Response(JSON.stringify({ esearchresult: { count: '123', idlist: [] } }));
  });
  expect(await s.call('count')).toBe(0);
  expect(queries).toHaveLength(7);
  expect(queries.slice(-2)).toEqual(rowQueries(s.table).map((row) => row.query));
  expect(s.runtime.stdout).toHaveBeenCalledWith('全体: 123 件\n#1: 123 件\n#RCTfilter: 123 件\n#Date: 123 件\n#2: 123 件\n#1 行 1（総称: 総称）: 123 件\n#1 行 2（個別の名称: 名称）: 123 件\n');
  expect(readBudget(s.dir)).toEqual({ measurements: 1, submissions: 0 });
});
test('行のクエリ拒否も検査不合格として記録し、測定を消費しない', async () => {
  const s = setup();
  let calls = 0;
  s.runtime.fetchImpl = jest.fn(async (input) => {
    if (!new URL(String(input)).pathname.endsWith('/esearch.fcgi')) throw new Error('想定外の通信');
    return new Response(JSON.stringify({ esearchresult: ++calls === 6 ? { ERROR: '検索式が不正です' } : { count: '123', idlist: [] } }));
  });
  expect(await s.call('count')).toBe(1);
  expect(readBudget(s.dir)).toEqual({ measurements: 0, submissions: 0 });
  expect(JSON.parse(readFileSync(join(s.dir, 'tool-log.jsonl'), 'utf8')).result).toBe('検査不合格');
});
test('表でない版は従来の式ファイルと出力と保存を使う', async () => {
  const s = setup(false);
  expect(await s.call('check')).toBe(0);
  expect(s.runtime.stdout).toHaveBeenCalledWith('検査に通りました\n');
  expect(await s.call('submit')).toBe(0);
  expect(readdirSync(join(s.dir, 'submissions'))).toEqual(['1.md']);
  expect(readFileSync(join(s.dir, 'tool-log.jsonl'), 'utf8')).toContain('式ファイル 1 件');
  writeFileSync(s.file, JSON.stringify(s.table));
  expect(await s.call('check')).toBe(1);
});
