import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CASES, type BenchCase, type FrozenSeeds, type GoldAudit, type StudyGroup } from './types';

export const FIXTURES = resolve(__dirname, 'fixtures');
const SEED = 20260912;

export interface GoldRecord {
  pmcid: string;
  included_pmids: string[];
  excluded_pmids: string[];
  included_without_pmid: string[];
  pmid_to_study_id: Record<string, string | string[]>;
}

export interface ParsedReview {
  title: string;
  objectives: string;
  eligibility: Record<string, string>;
  license: string;
  included_studies: { study_id: string; pmids: string[]; raw_citation?: string }[];
}

export function buildProtocol(parsed: ParsedReview): string {
  const fields = ['types_of_studies', 'types_of_participants', 'types_of_interventions', 'types_of_outcomes'];
  return `# ${parsed.title}\n\n## Objectives\n${parsed.objectives}\n\n`
    + fields.map((field) => `## ${field}\n${parsed.eligibility[field] ?? ''}\n`).join('\n');
}

const unique = (items: string[]) => [...new Set(items)].sort();
const studyNames = (value: string | string[] | undefined) => unique((typeof value === 'string' ? [value] : value ?? []).map((name) => name.trim().toLowerCase()).filter(Boolean));
const pmidOrder = (a: string, b: string) => a.length - b.length || a.localeCompare(b);

export function auditGold(gold: GoldRecord, parsed: ParsedReview): { groups: StudyGroup[]; audit: GoldAudit } {
  const included = unique(gold.included_pmids);
  const mapping = new Map(included.map((pmid) => [pmid, studyNames(gold.pmid_to_study_id[pmid])]));
  const names = unique([...mapping.values()].flat());
  const parents = new Map(names.map((name) => [name, name]));
  const root = (name: string): string => {
    const parent = parents.get(name)!;
    if (parent === name) return name;
    const result = root(parent);
    parents.set(name, result);
    return result;
  };
  for (const studies of mapping.values()) {
    for (const name of studies.slice(1)) parents.set(root(name), root(studies[0]!));
  }
  const memberSets = new Map<string, string[]>();
  for (const name of names) memberSets.set(root(name), [...(memberSets.get(root(name)) ?? []), name]);
  const groups = [...memberSets.values()].map((members) => ({
    id: members.join(' + '), members: members.map((studyId) => ({ studyId,
      pmids: included.filter((pmid) => mapping.get(pmid)!.includes(studyId)).sort(pmidOrder) })),
    pmids: included.filter((pmid) => mapping.get(pmid)!.some((name) => members.includes(name))).sort(pmidOrder),
  })).sort((a, b) => a.id.localeCompare(b.id, 'en'));
  const publicationYears: Record<string, number | null> = Object.fromEntries(included.map((pmid) => [pmid, null]));
  // 複数報告を束ねた引用の年は、個々の PMID の出版年と断定しない。
  for (const study of parsed.included_studies) {
    if (study.pmids.length !== 1) continue;
    const year = study.raw_citation?.match(/((?:18|19|20)\d{2})\s*;/)?.[1];
    const pmid = study.pmids[0]!;
    if (year && included.includes(pmid)) publicationYears[pmid] = Number(year);
  }
  const overlapPmids = included.filter((pmid) => gold.excluded_pmids.includes(pmid));
  const sharedPmids = [...mapping].filter(([, studies]) => studies.length > 1).map(([pmid, studies]) => ({ pmid, studies }));
  const unmappedPmids = included.filter((pmid) => mapping.get(pmid)!.length === 0);
  const withoutPmid = unique([...gold.included_without_pmid,
    ...parsed.included_studies.filter((study) => !study.pmids.length).map((study) => study.study_id)].map((name) => name.toLowerCase()));
  return { groups, audit: {
    includedStudyCount: names.length, includedPmidCount: included.length,
    overlapPmids, sharedPmids, unmappedPmids, withoutPmid, publicationYears,
    exclusions: { withoutPmid: withoutPmid.length, unresolvedMapping: unmappedPmids.length, outsideDate: null },
    manual_review: overlapPmids.length > 0 || sharedPmids.length > 0 || unmappedPmids.length > 0,
    reviewNote: '', dateValidation: 'pending',
  } };
}

export function selectSeeds(groups: readonly StudyGroup[], years: Record<string, number | null>): FrozenSeeds {
  if (groups.length < 3) throw new Error('シード用に 3 群以上必要です');
  let state = SEED;
  const random = () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 4294967296; };
  const shuffled = [...groups].sort((a, b) => a.id.localeCompare(b.id, 'en'));
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  return { seed: SEED, selections: shuffled.slice(0, 3).map((group) => {
    const allKnown = group.pmids.every((pmid) => years[pmid] != null);
    const pmid = [...group.pmids].sort((a, b) => (allKnown ? years[a]! - years[b]! : 0) || pmidOrder(a, b))[0]!;
    return { groupId: group.id, pmid, year: years[pmid] ?? null };
  }) };
}

export function validateSeeds(seeds: FrozenSeeds, groups: StudyGroup[]): void {
  if (seeds.seed !== SEED || seeds.selections.length !== 3 || new Set(seeds.selections.map((s) => s.groupId)).size !== 3
    || seeds.selections.some((s) => !groups.find((g) => g.id === s.groupId)?.pmids.includes(s.pmid))) {
    throw new Error('凍結済みシードと gold の群構造が一致しません');
  }
}

export function prepare(benchDir = process.env.COCHRANE_BENCH_DIR ?? 'C:\\Users\\youki\\codes\\Cochrane-bench', fixtureDir = FIXTURES): void {
  if (!existsSync(benchDir)) throw new Error('Cochrane-bench が見つかりません。COCHRANE_BENCH_DIR にデータのディレクトリを設定してください');
  const records = readFileSync(join(benchDir, 'data/processed/cc-by/gold/task2_search_screen.jsonl'), 'utf8')
    .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as GoldRecord);
  for (const definition of CASES) {
    const gold = records.find((record) => record.pmcid === definition.pmcid);
    if (!gold) throw new Error(`${definition.pmcid}: gold がありません`);
    const parsed = JSON.parse(readFileSync(join(benchDir, `data/interim/cc-by/parsed/${definition.pmcid}.json`), 'utf8')) as ParsedReview;
    const { groups, audit } = auditGold(gold, parsed);
    const dir = join(fixtureDir, definition.id);
    mkdirSync(dir, { recursive: true });
    const seedPath = join(dir, 'seeds.json');
    const seeds: FrozenSeeds = existsSync(seedPath) ? JSON.parse(readFileSync(seedPath, 'utf8')) : selectSeeds(groups, audit.publicationYears);
    validateSeeds(seeds, groups);
    if (!existsSync(seedPath)) writeFileSync(seedPath, JSON.stringify(seeds, null, 2) + '\n', { flag: 'wx' });
    const auditPath = join(dir, 'audit.json');
    if (existsSync(auditPath)) {
      const old = JSON.parse(readFileSync(auditPath, 'utf8')) as GoldAudit;
      if (JSON.stringify([old.overlapPmids, old.sharedPmids, old.unmappedPmids]) === JSON.stringify([audit.overlapPmids, audit.sharedPmids, audit.unmappedPmids])) {
        audit.manual_review = old.manual_review;
        audit.reviewNote = old.reviewNote;
      }
    }
    const heldOut = groups.filter((g) => !seeds.selections.some((s) => s.groupId === g.id)).map((g) => g.id);
    const fixture: BenchCase = { ...definition, license: parsed.license, protocolPath: 'protocol.md', gold: groups, heldOut, seeds };
    writeFileSync(join(dir, 'protocol.md'), buildProtocol(parsed));
    if (!existsSync(auditPath)) writeFileSync(auditPath, JSON.stringify(audit, null, 2) + '\n');
    writeFileSync(join(dir, 'case.json'), JSON.stringify(fixture, null, 2) + '\n');
    process.stdout.write(`${definition.id}: studies=${audit.includedStudyCount}, goldPMIDs=${audit.includedPmidCount}, groups=${groups.length}, heldOutGroups=${heldOut.length}, heldOutStudies=${groups.filter((g) => heldOut.includes(g.id)).reduce((sum, g) => sum + g.members.length, 0)}, exclusions=${JSON.stringify(audit.exclusions)}\n`);
  }
}

if (require.main === module) prepare();
