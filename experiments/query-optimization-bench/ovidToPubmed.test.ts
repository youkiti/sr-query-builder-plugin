/** @jest-environment node */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalQuery, compareHuman, generateB1 } from './b1';
import { parseOvid, transpile, type ManualOverride } from './ovidToPubmed';
import { CASES } from './types';
import * as types from './types';

const source = (name: string) => readFileSync(join(__dirname, 'b1', name), 'utf8');
const convert = (body: string) => transpile([{ n: 1, body }])[0]!;
const allowlist = JSON.parse(source('mesh-allowlist.json')) as Record<string, string[]>;
const developmentCases = CASES.filter((c) => c.role === 'development');
const sourceNumbers: Record<string, number> = {
  'r1-mindfulness-smoking': 1,
  'r2-pdr-prognostic': 2,
  'r3-vascular-bleeding': 3,
};

test.each([
  [1, [3, 8, 11, 12, 14, 17, 18]],
  [2, [35, 37, 41, 45, 46, 47, 50, 60, 61, 66, 71, 73, 74]],
])('human reference R%i matches except explicitly reported rule disagreements', (n, disagreements) => {
  const id = developmentCases.find((c) => sourceNumbers[c.id] === n)!.id;
  const lines = transpile(parseOvid(source(`r${n}_ovid.txt`)), { meshHeadings: allowlist[id] });
  const differences = compareHuman(source(`r${n}.md`), lines);
  // Keep disagreements visible without teaching the converter case-specific expectations.
  // The generated b1.md records both values for every disagreement, including dependent rows.
  expect(differences.map((line) => line.n)).toEqual(disagreements);
  for (const line of differences) expect(line.actual).not.toBe(line.expected);
});

test('R3 splits its single physical line into all 132 steps and expands the final references', () => {
  const lines = parseOvid(source('r3_ovid.txt'));
  expect(lines).toHaveLength(132);
  expect(lines[131]).toEqual({ n: 132, body: '104 and 131' });
  const result = transpile(lines);
  expect(result[131]!.query).not.toMatch(/#\d|\badj\d*\b|\?/i);
  expect(result[131]!.query.includes('NOT (("Animals"[Mesh] NOT "Humans"[Mesh]))')).toBe(true);
  expect(result[119]!.query).toBe('"Randomized Controlled Trial"[pt]');
  expect(result[119]!.approximations[0]!.kind).toBe('field_widened');
});

test('references expand recursively with parentheses and preserve NOT operands', () => {
  const rows = transpile(parseOvid('1. Alpha/ 2. exp Beta/ 3. or/1‐2 4. 3 not 2'));
  expect(rows[2]!.query).toBe('(("Alpha"[Mesh:noexp]) OR ("Beta"[Mesh]))');
  expect(canonicalQuery(rows[3]!.query)).toBe(canonicalQuery('((("Alpha"[Mesh:noexp]) OR ("Beta"[Mesh])) NOT ("Beta"[Mesh]))'));
  expect(() => convert('or/1-2')).toThrow('unresolved reference');
});

test('subheadings require known abbreviations and preserve explosion and major topic', () => {
  expect(convert('Vascular Diseases/su').query).toBe('"Vascular Diseases/surgery"[Mesh:noexp]');
  expect(convert('exp Aneurysm/su').query).toBe('"Aneurysm/surgery"[Mesh]');
  expect(convert('*Fibrinogen/').query).toBe('"Fibrinogen"[MAJR:noexp]');
  expect(convert('Fibrinogen/ad, ae').query).toBe('("Fibrinogen/administration and dosage"[Mesh:noexp] OR "Fibrinogen/adverse effects"[Mesh:noexp])');
  expect(() => convert('Aneurysm/unknown')).toThrow('unknown subheading unknown');
});

test('proximity uses N minus one; truncated operands become AND with a recorded approximation', () => {
  expect(convert('(acceptance adj2 commitment).tw.').query).toBe('"acceptance commitment"[tiab:~1]');
  expect(convert('(a adj b).ti.').query).toBe('"a b"[ti:~0]');
  expect(convert('((a or b) adj3 c).tw.').query).toBe('("a c"[tiab:~2] OR "b c"[tiab:~2])');
  const truncated = convert('((risk* or rate*) adj5 progress*).tw.');
  expect(truncated.query).toBe('((risk*[tiab] OR rate*[tiab]) AND progress*[tiab])');
  expect(truncated.approximations).toContainEqual({ kind: 'proximity_to_and', detail: '(risk* or rate*) adj5 progress*' });
});

test('field unions, field widening, journal aliases and mixed field lines', () => {
  expect(convert('alpha.tw,kf.').query).toBe('(alpha[tiab] OR alpha[ot])');
  expect(convert('alpha.mp.').query).toBe('alpha[tiab]');
  expect(convert('alpha.ab.').approximations[0]!.kind).toBe('field_widened');
  expect(convert('alpha.ab. or beta.tw.').query).toBe('(alpha[tiab] OR beta[tiab])');
  expect(convert('Cochrane Database of systematic reviews.jn.').query).toBe('"Cochrane Database Syst Rev"[ta]');
});

test('known wildcards and phrase truncation expand; unknown patterns remain in the audit', () => {
  expect(convert('neo?vasculari*.tw.').query).toBe('(neovascularis*[tiab] OR neovasculariz*[tiab])');
  const phrase = convert('"risk factor*".tw.');
  expect(phrase.query).toBe('("risk factor"[tiab] OR "risk factors"[tiab])');
  expect(phrase.approximations[0]!.kind).toBe('phrase_truncation');
  expect(convert('"factor*".tw.').query).toBe('("factor"[tiab] OR "factors"[tiab])');
  const unknown = convert('(unknown?word or known).tw.');
  expect(unknown.query).toBe('known[tiab]');
  expect(unknown.approximations).toEqual([{ kind: 'unsupported', detail: 'unknown?word' }]);
  const dropped = transpile(parseOvid('1. unknown?word.tw. 2. alpha.tw. 3. or/1-2'));
  expect(dropped[2]!.query).toBe('(alpha[tiab])');
});

test('reference comparison handles multiline expressions and normalizes only Boolean presentation', () => {
  expect(canonicalQuery('(alpha[tiab] OR "beta"[tiab])')).toBe(canonicalQuery('(BETA[tiab] OR (alpha[tiab]))'));
  expect(canonicalQuery('')).toBe('');
  expect(compareHuman('```\n1 alpha[tiab]\n2 (beta[tiab] OR\n gamma[tiab])\n3 #1 AND #2\n```',
    transpile(parseOvid('1. alpha.tw. 2. (beta or gamma).tw. 3. 1 and 2')))).toEqual([]);
});

test.each(['natural histor*.tw.', 'partial* sight*.tw.', 'rubeosis iridis*.tw.', 'relationship* between.tw.'])('unknown phrase stems require review: %s', (body) => {
  const line = convert(body);
  expect(line.query).toBe('');
  expect(line.approximations.map((a) => a.kind)).toEqual(['phrase_truncation', 'unsupported']);
});

test('mp requires a complete allowlisted heading and never assigns Mesh to truncated terms', () => {
  const line = transpile([{ n: 1, body: '(SMOKING* or TOBACCO or nicotine* or "risk factor*" or "Smoking Cessation" or tobacco use).mp.' }],
    { meshHeadings: ['SMOKING*', 'Tobacco', 'nicotine*', 'risk factor', 'risk factors', 'Smoking Cessation'] })[0]!;
  expect(line.query).toContain('TOBACCO[Mesh]');
  expect(line.query).toContain('"Smoking Cessation"[Mesh]');
  expect(line.query).not.toMatch(/(?:SMOKING\*|nicotine\*|"risk factors?"|"tobacco use")\[Mesh\]/);
  expect(line.query).toContain('"risk factors"[tiab]');
  expect(line.approximations.filter((a) => a.kind === 'mesh_dropped')).toHaveLength(4);
  expect(line.approximations.some((a) => a.kind === 'field_widened')).toBe(false);
  developmentCases.forEach((definition) => {
    const lines = transpile(parseOvid(source(`r${sourceNumbers[definition.id]}_ovid.txt`)), { meshHeadings: allowlist[definition.id] });
    for (const row of lines) expect(row.query).not.toMatch(/(?:"[^"\n]*\*[^"\n]*"|[^\s()"]*\*[^\s()"]*)\[Mesh\]/i);
  });
});

test('overrides replace references and reject missing rationale or nonexistent line numbers', () => {
  const lines = parseOvid('1. natural histor*.tw. 2. 1 and alpha.tw.');
  const overrides = { '1': { query: '"natural history"[tiab]', note: 'Manual source interpretation' } };
  expect(transpile(lines, { overrides })[1]!.query).toBe('(("natural history"[tiab]) AND alpha[tiab])');
  expect(() => transpile(lines, { overrides: { '3': overrides['1'] } })).toThrow('Invalid override');
  expect(() => transpile(lines, { overrides: { '1': { query: 'x', note: '' } } })).toThrow('Invalid override');
});

test('offline generation blocks unresolved cases, then uses override files and preserves frozen outputs', () => {
  const network = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Real network forbidden'));
  const output = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
  const confirmation = { id: 'confirmation-without-b1', pmcid: 'PMC123', searchDate: '2020-01-01', role: 'confirmation' };
  const cases = jest.replaceProperty(types, 'CASES', developmentCases.flatMap((c) => [confirmation, c]) as unknown as typeof CASES);
  try {
    const dir = mkdtempSync(join(tmpdir(), 'b1-test-'));
    const sources = join(dir, 'source');
    cpSync(join(__dirname, 'b1'), sources, { recursive: true });
    expect(generateB1(dir, sources)).toBe(false);
    developmentCases.forEach((c) => {
      expect(existsSync(join(dir, c.id, 'b1.json'))).toBe(false);
      expect(existsSync(join(dir, c.id, 'b1.md'))).toBe(false);
      const review = readFileSync(join(sources, `review-${c.id}.md`), 'utf8');
      expect(review).toContain('人手判断が必要な行');
      const unresolved = transpile(parseOvid(source(`r${sourceNumbers[c.id]}_ovid.txt`))).filter((line) =>
        line.approximations.some((a) => a.kind === 'unsupported' && !a.detail.includes('reference')));
      const overrides: Record<string, ManualOverride> = Object.fromEntries(unresolved.map((line) =>
        [String(line.n), { query: `manual${line.n}[tiab]`, note: `Test rationale for ${line.n}` }]));
      mkdirSync(join(sources, 'overrides'), { recursive: true });
      writeFileSync(join(sources, 'overrides', `${c.id}.json`), JSON.stringify(overrides));
      for (const line of unresolved) { expect(review).toContain(`元の式: ${line.source}`); }
    });
    expect(generateB1(dir, sources)).toBe(true);
    expect(existsSync(join(dir, confirmation.id))).toBe(false);
    expect(existsSync(join(sources, `review-${confirmation.id}.md`))).toBe(false);
    const files = developmentCases.flatMap((c) => ['b1.json', 'b1.md'].map((name) => join(dir, c.id, name)));
    const before = files.map((file) => readFileSync(file, 'utf8'));
    developmentCases.forEach((c) => {
      const query = JSON.parse(readFileSync(join(dir, c.id, 'b1.json'), 'utf8')).query;
      const overrides = JSON.parse(readFileSync(join(sources, 'overrides', `${c.id}.json`), 'utf8')) as Record<string, ManualOverride>;
      const converted = transpile(parseOvid(source(`r${sourceNumbers[c.id]}_ovid.txt`)), { meshHeadings: allowlist[c.id], overrides });
      expect(query).toBe(converted[converted.length - 1]!.query);
      const report = readFileSync(join(dir, c.id, 'b1.md'), 'utf8');
      for (const override of Object.values(overrides)) {
        expect(report).toContain(`人手上書き: ${override.note}`);
        expect(report).toContain(override.query);
      }
    });
    generateB1(dir, join(dir, 'missing-source'));
    expect(files.map((file) => readFileSync(file, 'utf8'))).toEqual(before);
    expect(network).not.toHaveBeenCalled();
  } finally { cases.restore(); network.mockRestore(); output.mockRestore(); }
});
