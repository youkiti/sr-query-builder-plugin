/** @jest-environment node */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as types from './types';
import { prepare } from './prepare';
import { main as freeze } from './freezeC0';
import { main as optimize, parseArgs } from './run';

jest.mock('./gitInfo', () => ({ getGitCommit: () => 'synthetic', isGitDirty: () => false }));

test('CASES に confirmation の行を加えるだけで prepare・freeze・optimize の dry-run が動く', async () => {
  const root = mkdtempSync(join(tmpdir(), 'confirmation-registration-'));
  const fixtures = join(root, 'fixtures');
  const definition = { id: 'c1-drugs-to-reduce', pmcid: 'PMC123', searchDate: '2020-01-02', role: 'confirmation' };
  jest.replaceProperty(types, 'CASES', [definition] as unknown as typeof types.CASES);
  const output = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
  try {
    mkdirSync(join(root, 'data/processed/cc-by/gold'), { recursive: true });
    mkdirSync(join(root, 'data/interim/cc-by/parsed'), { recursive: true });
    writeFileSync(join(root, 'data/processed/cc-by/gold/task2_search_screen.jsonl'), JSON.stringify({ pmcid: 'PMC123',
      included_pmids: ['1', '2', '3', '4'], excluded_pmids: [], included_without_pmid: [], pmid_to_study_id: { '1': 'a', '2': 'b', '3': 'c', '4': 'd' } }));
    writeFileSync(join(root, 'data/interim/cc-by/parsed/PMC123.json'), JSON.stringify({ title: 'test', objectives: 'goal', eligibility: {}, license: 'CC BY', included_studies: [] }));
    prepare(root, fixtures, 20260915);
    expect(JSON.parse(readFileSync(join(fixtures, definition.id, 'case.json'), 'utf8'))).toMatchObject(definition);
    expect(parseArgs(['--case', definition.id]).ids).toEqual([definition.id]);
    await freeze(['--case', definition.id, '--variant', 'criteria-only', '--draft', '11', '--dry-run'], fixtures, join(root, 'results'));
    await freeze(['--case', definition.id, '--variant', 'seeded', '--seeds', '20260915', '--draft', '11', '--dry-run'], fixtures, join(root, 'results'));
    await optimize(['--case', definition.id, '--seeds', '20260915', '--dry-run'], fixtures, join(root, 'results'));
    expect(output.mock.calls.flat().join('')).toContain('dry-run OK');
  } finally { jest.restoreAllMocks(); }
});
