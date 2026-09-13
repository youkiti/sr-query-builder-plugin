/** @jest-environment node */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { c0Dir, c0FileName, c0FixturePath, hashC0Content, loadC0Artifact, type C0Content } from './c0Artifact';

const baseContent: C0Content = {
  schemaVersion: 1, caseId: 'case-a', variant: 'seeded', draftIndex: 1, seedSplit: 's20260912', targetHits: 2000,
  model: 'gemini-test', createdAt: '2026-09-13T00:00:00.000Z', gitCommit: 'abc123', gitDirty: false,
  protocol: { frameworkType: 'custom', researchQuestion: 'RQ', inclusionCriteria: 'include', exclusionCriteria: '',
    studyDesign: 'any', sourceType: 'markdown', sourceFilename: 'protocol.md', rawTextRef: null, rawTextPreview: 'p', rawTextInline: 'p' },
  blocks: { blocks: [{ blockLabel: 'Concept', description: 'd', aiGenerated: true, note: '' }], combinationExpression: '#1' },
  formula: { blocks: [{ id: '1', expression: 'test[tiab]', isCombination: false }], combinationExpression: null },
  formulaMd: '```\n#1 test[tiab]\n```',
  seedContext: { titles: ['Seed'], samples: [{ title: 'Seed', abstract: null }], meshSummary: { seedCount: 1, concepts: [], checkTags: [] } },
  blockApproval: 'auto',
};

test('c0FileName は既定 split では接尾辞を付けず、それ以外は付ける', () => {
  expect(c0FileName('criteria-only', 1, null)).toBe('criteria-only-draft1');
  expect(c0FileName('seeded', 2, 's42')).toBe('seeded-draft2-s42');
});

test('hashC0Content はキー順序に依存せず、内容が変われば変わる', () => {
  // トップレベルのキー挿入順を逆にしただけの、値としては同一のオブジェクト。
  const reordered = Object.fromEntries(Object.entries(baseContent).reverse()) as unknown as C0Content;
  expect(hashC0Content(baseContent)).toBe(hashC0Content(reordered));
  expect(hashC0Content(baseContent)).not.toBe(hashC0Content({ ...baseContent, targetHits: 1000 }));
});

test('loadC0Artifact はケース ID 不一致・ハッシュ不一致を拒否し、正しい fixture は読める', () => {
  const dir = mkdtempSync(join(tmpdir(), 'c0-artifact-'));
  mkdirSync(c0Dir(dir, 'case-a'), { recursive: true });
  const sha256 = hashC0Content(baseContent);
  writeFileSync(c0FixturePath(dir, 'case-a', 'seeded-draft1'), JSON.stringify({ ...baseContent, sha256 }));
  const loaded = loadC0Artifact(dir, 'case-a', 'seeded-draft1');
  expect(loaded.sha256).toBe(sha256);
  expect(loaded.formula).toEqual(baseContent.formula);

  mkdirSync(c0Dir(dir, 'case-b'), { recursive: true });
  writeFileSync(c0FixturePath(dir, 'case-b', 'mismatch'), JSON.stringify({ ...baseContent, sha256 }));
  expect(() => loadC0Artifact(dir, 'case-b', 'mismatch')).toThrow('ケース ID');

  writeFileSync(c0FixturePath(dir, 'case-a', 'tampered'), JSON.stringify({ ...baseContent, targetHits: 999, sha256 }));
  expect(() => loadC0Artifact(dir, 'case-a', 'tampered')).toThrow('ハッシュが一致しません');

  expect(() => loadC0Artifact(dir, 'case-a', 'missing')).toThrow('見つかりません');
});
