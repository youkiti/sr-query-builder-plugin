import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CASES, type BenchCase, type FrozenSeeds, type GoldAudit, type StudyGroup } from './types';
import { seededShuffle } from './shuffle';

export const FIXTURES = resolve(__dirname, 'fixtures');
/** 既定のシード分割の乱数。`fixtures/<id>/seeds.json` はこの値で凍結されている。 */
export const SEED = 20260912;

/** 数値は従来の乱数分割、文字列は名前付き集合。 */
export type SeedSplit = number | string;

function isSeedName(name: unknown): name is string {
  return typeof name === 'string' && name.trim() === name && /^[a-z][a-z0-9-]{0,31}$/.test(name) && !/^s-?\d+$/.test(name);
}

/** 10 進の非負整数表記を先に判定し、それ以外は集合名として検証する。 */
export function parseSeedSplit(raw: string): SeedSplit {
  const seed = Number(raw);
  if (raw.trim() === raw && /^(0|[1-9]\d*)$/.test(raw) && Number.isSafeInteger(seed)) return seed;
  if (isSeedName(raw)) return raw;
  throw new Error('--seeds には10 進の非負整数または名前（英小文字で始まる英小文字・数字・ハイフンの 1〜32 文字）を指定してください。s または s- に数字だけを続けた名前は整数分割の id と衝突するため使用できません');
}

/** 分割を指す短い id（結果ディレクトリのキーやログ表示に使う）。 */
export function seedSplitId(seed: SeedSplit): string {
  return typeof seed === 'number' ? `s${seed}` : seed;
}

export function seedFileName(seed: SeedSplit): string {
  return seed === SEED ? 'seeds.json' : `seeds-${seed}.json`;
}

/**
 * 指定した分割の凍結シードを読む。存在しなければ、先に用意すべきコマンドを示して失敗する。
 * ファイル名は分割指定から機械的に決まるが、ファイルの中身（`seed` または `name`）が
 * 要求した値と食い違っていたら（手動編集・コピー間違い等）実行前に拒否する。
 */
export function loadSeedsFile(fixtureDir: string, seed: SeedSplit): FrozenSeeds {
  if (typeof seed === 'string' && !isSeedName(seed)) throw new Error('シード集合名が不正です');
  const path = join(fixtureDir, seedFileName(seed));
  if (!existsSync(path)) {
    if (typeof seed === 'string') {
      throw new Error(`${path} が見つかりません。名前付き集合は手動で {"name":"${seed}","selections":[{"groupId":"群 ID","pmid":"PMID","year":null}, ...]} の形式で異なる 3 群を指定してください（seed フィールドは指定しない）`);
    }
    throw new Error(`${path} が見つかりません。先に \`npm run eval:prepare -- --seed ${seed}\` を実行してください`);
  }
  const seeds = JSON.parse(readFileSync(path, 'utf8')) as FrozenSeeds;
  if (typeof seed === 'string') {
    if (seeds.name !== seed || seeds.seed !== undefined) {
      throw new Error(`${path} の name（${seeds.name}）が要求した集合（${seed}）と一致しないか、乱数分割の seed が混在しています`);
    }
  } else if (seeds.seed !== seed || seeds.name !== undefined) {
    throw new Error(`${path} の seed（${seeds.seed}）が要求した分割（${seed}）と一致しません`);
  }
  return seeds;
}

/** held-out = 選択した分割のシード群を除いた残り全群。分割ごとに実行時に求める。 */
export function computeHeldOut(groups: readonly StudyGroup[], seeds: FrozenSeeds): string[] {
  return groups.filter((group) => !seeds.selections.some((selection) => selection.groupId === group.id)).map((group) => group.id);
}

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

export function selectSeeds(groups: readonly StudyGroup[], years: Record<string, number | null>, seed = SEED): FrozenSeeds {
  if (groups.length < 3) throw new Error('シード用に 3 群以上必要です');
  const shuffled = seededShuffle([...groups].sort((a, b) => a.id.localeCompare(b.id, 'en')), seed);
  return { seed, selections: shuffled.slice(0, 3).map((group) => {
    const allKnown = group.pmids.every((pmid) => years[pmid] != null);
    const pmid = [...group.pmids].sort((a, b) => (allKnown ? years[a]! - years[b]! : 0) || pmidOrder(a, b))[0]!;
    return { groupId: group.id, pmid, year: years[pmid] ?? null };
  }) };
}

// 分割の識別形式と、3 群を一意に選び出す群構造との整合を検証する。要求値との照合はロード時に行う。
export function validateSeeds(seeds: FrozenSeeds, groups: StudyGroup[]): void {
  const validIdentity = (Number.isSafeInteger(seeds.seed) && seeds.name === undefined)
    || (isSeedName(seeds.name) && seeds.seed === undefined);
  if (!validIdentity || !Array.isArray(seeds.selections) || seeds.selections.length !== 3 || new Set(seeds.selections.map((s) => s.groupId)).size !== 3
    || seeds.selections.some((s) => !groups.find((g) => g.id === s.groupId)?.pmids.includes(s.pmid))) {
    throw new Error('凍結済みシードと gold の群構造が一致しません');
  }
}

/**
 * @param extraSeed 追加で凍結するシード分割の乱数（`--seed`）。既定分割（SEED）と同じ値なら無視する。
 *   一度書いた分割ファイルは上書きしない（`wx`）。
 */
export function prepare(benchDir = process.env.COCHRANE_BENCH_DIR ?? 'C:\\Users\\youki\\codes\\Cochrane-bench', fixtureDir = FIXTURES, extraSeed?: number): void {
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
    if (extraSeed !== undefined && extraSeed !== SEED) {
      const altPath = join(dir, seedFileName(extraSeed));
      if (!existsSync(altPath)) {
        const alt = selectSeeds(groups, audit.publicationYears, extraSeed);
        validateSeeds(alt, groups);
        writeFileSync(altPath, JSON.stringify(alt, null, 2) + '\n', { flag: 'wx' });
      }
    }
    const auditPath = join(dir, 'audit.json');
    if (existsSync(auditPath)) {
      const old = JSON.parse(readFileSync(auditPath, 'utf8')) as GoldAudit;
      if (JSON.stringify([old.overlapPmids, old.sharedPmids, old.unmappedPmids]) === JSON.stringify([audit.overlapPmids, audit.sharedPmids, audit.unmappedPmids])) {
        audit.manual_review = old.manual_review;
        audit.reviewNote = old.reviewNote;
      }
    }
    const heldOut = computeHeldOut(groups, seeds);
    const fixture: BenchCase = { ...definition, license: parsed.license, protocolPath: 'protocol.md', gold: groups, heldOut, seeds };
    writeFileSync(join(dir, 'protocol.md'), buildProtocol(parsed));
    if (!existsSync(auditPath)) writeFileSync(auditPath, JSON.stringify(audit, null, 2) + '\n');
    writeFileSync(join(dir, 'case.json'), JSON.stringify(fixture, null, 2) + '\n');
    process.stdout.write(`${definition.id}: studies=${audit.includedStudyCount}, goldPMIDs=${audit.includedPmidCount}, groups=${groups.length}, heldOutGroups=${heldOut.length}, heldOutStudies=${groups.filter((g) => heldOut.includes(g.id)).reduce((sum, g) => sum + g.members.length, 0)}, exclusions=${JSON.stringify(audit.exclusions)}\n`);
  }
}

/** `--seed <int>` だけを読む。未指定なら undefined（既定分割のみ準備する、従来どおりの挙動）。 */
export function parsePrepareArgs(args: string[]): { seed?: number } {
  const index = args.indexOf('--seed');
  if (index === -1) return {};
  const raw = args[index + 1];
  const seed = Number(raw);
  if (raw === undefined || !Number.isSafeInteger(seed)) throw new Error('--seed には整数を指定してください');
  return { seed };
}

if (require.main === module) prepare(undefined, undefined, parsePrepareArgs(process.argv.slice(2)).seed);
