/** @jest-environment node */
import fs from 'node:fs';
import dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';
import { main } from './run';

test('実行開始行にプロセス条件を 1 回残し、キー値は保存しない', async () => {
  const previousGemini = process.env.GEMINI_API_KEY;
  const previousNcbi = process.env.NCBI_API_KEY;
  const previousExit = process.exitCode;
  const secret = randomUUID();
  delete process.env.GEMINI_API_KEY;
  process.env.NCBI_API_KEY = secret;
  jest.spyOn(dotenv, 'config').mockReturnValue({});
  jest.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
  jest.spyOn(fs, 'existsSync').mockReturnValue(false);
  jest.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);
  jest.spyOn(fs, 'renameSync').mockReturnValue(undefined);
  const append = jest.spyOn(fs, 'appendFileSync').mockReturnValue(undefined);
  jest.spyOn(process.stdout, 'write').mockReturnValue(true);
  const network = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('実 API 禁止'));
  try {
    // LLM キー未設定で API 発行前に止めても開始条件は記録される。
    await main(['--case', 'r1-mindfulness-smoking']);
    const rows = append.mock.calls.map((call) => JSON.parse(String(call[1])));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ at: expect.any(String), event: { process: {
      pid: process.pid, hasApiKey: true, caseCount: 1, caseExecution: 'sequential',
      requestConcurrency: 'caller-dependent', externalConcurrency: 'unknown',
      gitCommit: expect.any(String), runId: expect.any(String),
    } } });
    expect(JSON.stringify(rows).includes(secret)).toBe(false);
    expect(network).not.toHaveBeenCalled();
  } finally {
    if (previousGemini === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousGemini;
    if (previousNcbi === undefined) delete process.env.NCBI_API_KEY;
    else process.env.NCBI_API_KEY = previousNcbi;
    process.exitCode = previousExit;
    jest.restoreAllMocks();
  }
});
