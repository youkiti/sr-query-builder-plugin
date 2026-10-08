/** @jest-environment node */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConditions } from './conditions';
import { main } from './prepareRuns';
import { runPath } from './runDir';
import { splitReviews } from './split';
import type { RunRuntime } from './startRuns';
import { fixture, record, review, writeJson, writeLines } from './testFixtures';

function setup(table = true) {
  const root = mkdtempSync(join(tmpdir(), 'p2f-prepare-'));
  const casesDir = join(root, 'cases');
  const harnessDir = join(root, 'harness');
  const rows = Array.from({ length: 10 }, (_, i) => review(i + 1));
  fixture(root, rows);
  writeLines(join(casesDir, 'evaluable.jsonl'), rows.map((row) => record(row)));
  const dev = rows.find((row) => splitReviews(rows).get(row.pmcid) === 'development')!;
  writeJson(join(casesDir, 'subsets.json'), { smoke: [dev.pmcid] });
  const version = table ? 'v11' : 'v1';
  const conditions = loadConditions(version);
  writeJson(join(harnessDir, version, 'conditions.json'), conditions);
  writeFileSync(join(harnessDir, version, 'procedure.md'), '# 内部\r\n<!-- 渡さない -->\r\n---\r\n\r\n本文\r\n');
  const dirs = [1, 2].map((i) => runPath(join(root, 'runs'), version, dev.pmcid, i));
  for (const dir of dirs) mkdirSync(dir, { recursive: true });
  const envFile = join(root, 'test.env');
  writeFileSync(envFile, 'NCBI_API_KEY=FAKE_SECRET\n');
  const runtime: RunRuntime = { casesDir, harnessDir, env: { COCHRANE_BENCH_DIR: root }, now: () => new Date(),
    stdout: jest.fn(), stderr: jest.fn(), fetchImpl: jest.fn(async () => { throw new Error('通信は禁止です'); }) };
  const args = ['--runs', join(root, 'runs'), '--version', version, '--subset', 'smoke', '--runs-per-review', '2', '--env-file', envFile, '--rps', '3'];
  return { root, dirs, args, runtime, conditions, version, harnessDir };
}
test.each([false, true])('版に合う文面と秘密を含まない LF の入口を作る: %j', (table) => {
  const s = setup(table);
  expect(main(s.args, s.runtime)).toBe(0);
  expect(s.runtime.stdout).toHaveBeenCalledWith('作成: 2 件\n');
  for (const dir of s.dirs) {
    const prompt = readFileSync(join(dir, 'prompt.txt'), 'utf8');
    expect(prompt).toContain('本文\n\n## この作業の設定\n');
    expect(prompt).not.toContain('渡さない');
    expect(prompt).toContain(table ? '表のファイルは作業フォルダに `table.json`' : '検索式ファイルは作業フォルダに `formula.md`');
    expect(prompt).toContain(`bash "${dir.replace(/\\/g, '/')}/tool.sh" count ${table ? 'table.json' : 'formula.md'}`);
    const script = readFileSync(join(dir, 'tool.sh'), 'utf8');
    expect(script).not.toMatch(/\r|FAKE_SECRET|api_key=|NCBI_API_KEY=/i);
    expect(script).toContain(`cd "${dir.replace(/\\/g, '/')}" || exit 9\n`);
    expect(script).toContain('P2F_NCBI_RPS=3 PYTHONUTF8=1 \\\n  node ');
    expect(script).toContain('node_modules/dotenv/config');
    expect(script).toContain('"$@"');
  }
  expect(s.runtime.fetchImpl).not.toHaveBeenCalled();
});
test.each(['prompt.txt', 'tool.sh'])('後の実行に %s が既にあれば何も書かない', (file) => {
  const s = setup();
  writeFileSync(join(s.dirs[1]!, file), '既存');
  expect(() => main(s.args, s.runtime)).toThrow('既に');
  expect(existsSync(join(s.dirs[0]!, 'prompt.txt'))).toBe(false);
  expect(existsSync(join(s.dirs[0]!, 'tool.sh'))).toBe(false);
  expect(readFileSync(join(s.dirs[1]!, file), 'utf8')).toBe('既存');
});
test('実行フォルダが不足していれば何も書かない', () => {
  const s = setup();
  s.args[s.args.indexOf('--runs-per-review') + 1] = '3';
  expect(() => main(s.args, s.runtime)).toThrow('実行フォルダがありません');
  for (const dir of s.dirs) expect(existsSync(join(dir, 'prompt.txt'))).toBe(false);
});
test.each(['0', '-1', '11', 'NaN', 'Infinity'])('不正な通信頻度を拒否する: %s', (rps) => {
  const s = setup();
  s.args[s.args.length - 1] = rps;
  expect(() => main(s.args, s.runtime)).toThrow('--rps');
});
test.each(['relative.env', 'missing.env', 'directory'])('環境ファイルの指定を検査する: %s', (file) => {
  const s = setup();
  s.args[s.args.indexOf('--env-file') + 1] = file === 'relative.env' ? file : file === 'directory' ? s.root : join(s.root, file);
  expect(() => main(s.args, s.runtime)).toThrow('--env-file');
});
test.each([{ seeds: { label: 'seed', max: 1 } }, { runner: 'gemini-api' }, { runner: 'openrouter-api', model: 'qwen/qwen3.8-flash', provider: 'alibaba' }])('未対応の版には何も作らない: %j', (override) => {
  const s = setup(false);
  writeJson(join(s.harnessDir, s.version, 'conditions.json'), { ...s.conditions, ...override });
  expect(() => main(s.args, s.runtime)).toThrow('この版には使えません');
  expect(existsSync(join(s.dirs[0]!, 'tool.sh'))).toBe(false);
});
test('重複した追加引数を拒否し、既存の引数検査も保つ', () => {
  const s = setup();
  expect(() => main([...s.args, '--rps', '2'], s.runtime)).toThrow('実行引数');
  expect(() => main([...s.args, '--unknown', 'x'], s.runtime)).toThrow('実行引数');
});

test('中継版は設定末尾をそろえ、秘密や実行環境を含まない LF の入口を作る', () => {
  const s = setup(false);
  writeJson(join(s.harnessDir, s.version, 'conditions.json'), { ...s.conditions, runner: 'codex-relay' });
  expect(main(s.args.slice(0, -4), s.runtime)).toBe(0);
  for (const dir of s.dirs) {
    const path = dir.replace(/\\/g, '/');
    const expected = `## この作業の設定

- 作業フォルダ: \`${path}\`
- \`TOOL\` は \`bash "${path}/tool.sh"\` です。例: \`bash "${path}/tool.sh" count formula.md\`、\`bash "${path}/tool.sh" mesh "語"\`。
- 検索式ファイルは作業フォルダに \`formula.md\` という名前で書いてください（道具には \`formula.md\` とだけ渡せば届きます）。
- 読んでよいファイルは、作業フォルダの \`protocol.md\` と、あなたが書いた \`formula.md\` だけです。\`tool.sh\` の中身や、作業フォルダの外は読まないでください。
- コマンドは 1 つずつ実行してください（同時に複数実行しない）。
- 道具が「測定に失敗しました」と返したら、少し待って同じコマンドをもう一度だけ試してください。
`;
    const prompt = readFileSync(join(dir, 'prompt.txt'), 'utf8');
    expect(prompt.endsWith(expected)).toBe(true);
    expect(prompt).not.toContain('タイムアウト');
    expect(readFileSync(join(dir, 'tool.sh'), 'utf8')).not.toMatch(/\r|\.env|node|tsx|NCBI_API_KEY/);
  }
});

test.each(['--env-file', '--rps'])('中継版の準備には %s を渡せない', (flag) => {
  const s = setup(false);
  writeJson(join(s.harnessDir, s.version, 'conditions.json'), { ...s.conditions, runner: 'codex-relay' });
  expect(() => main([...s.args.slice(0, -4), flag, s.args[s.args.indexOf(flag) + 1]!], s.runtime)).toThrow('渡せません');
});
