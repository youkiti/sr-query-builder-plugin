import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { config } from 'dotenv';
import { redact } from '../../query-optimization-bench/ncbiEval';
import type { SubmissionOutcome } from './metrics';
import { runPath, writeJson } from './runDir';
import { readSubmissionState, scoreMatchesSubmission, type StoredScore } from './scoreRuns';
import { parseRunOptions, targetReviews, type RunRuntime } from './startRuns';
import { defaultRuntime } from './tool';

export interface SeedSelection {
  pmids: string[]; studyIds: string[]; max: number; selectedAt: string; candidatesFingerprint: string;
}
interface Candidates { pmids: string[]; fingerprint: string }

export function readSeedSelection(path: string): SeedSelection {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as SeedSelection | null;
    if (!value || !Array.isArray(value.pmids) || value.pmids.some((pmid) => typeof pmid !== 'string' || !/^\d+$/.test(pmid))
      || new Set(value.pmids).size !== value.pmids.length || !Array.isArray(value.studyIds)
      || value.studyIds.some((id) => typeof id !== 'string' || !id) || new Set(value.studyIds).size !== value.studyIds.length
      || !Number.isInteger(value.max) || value.max < 1 || value.max > 5 || value.pmids.length > value.max
      || typeof value.candidatesFingerprint !== 'string' || !value.candidatesFingerprint
      || typeof value.selectedAt !== 'string' || !Number.isFinite(Date.parse(value.selectedAt))) throw new Error();
    return value;
  } catch { throw new Error('シードの選定の記録が不正か読み込めません'); }
}

function parseOptions(args: string[]) {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (key === '--subset' && ['validation', 'test'].includes(args[i + 1] ?? '')) throw new Error('シードの下調べは開発群でだけ実行できます');
    if (!['--runs', '--label', '--subset', '--max', '--from', '--base', '--runs-per-review'].includes(key) || values.has(key)
      || !args[i + 1] || args[i + 1]!.startsWith('--')) throw new Error('実行引数が不正です');
    values.set(key, args[++i]!);
  }
  const label = values.get('--label'), max = Number(values.get('--max'));
  const from = values.get('--from') ?? 'candidates', base = values.get('--base');
  if (!['candidates', 'missed'].includes(from)
    || (from === 'candidates' && (values.has('--base') || values.has('--runs-per-review')))
    || (from === 'missed' && (!base || !/^[A-Za-z0-9_-]+$/.test(base) || !values.has('--runs-per-review')))) {
    throw new Error('シードの選定元の指定が不足しているか不正です');
  }
  if (!label || !/^[A-Za-z0-9_-]+$/.test(label) || !Number.isInteger(max) || max < 1 || max > 5) throw new Error('シードの条件が不正です');
  return { ...parseRunOptions(['--runs', values.get('--runs') ?? '', '--version', label,
    '--subset', values.get('--subset') ?? '', '--runs-per-review', from === 'missed' ? values.get('--runs-per-review')! : '1'], '--runs'), label, max, from, base };
}

const missedVersion = 'seed-select-missed-v1';
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const comparePmids = (a: string, b: string): number => a.length - b.length || compareText(a, b);

function missedCandidates(review: ReturnType<typeof targetReviews>[number], options: ReturnType<typeof parseOptions>) {
  const captured = new Set<string>(), fingerprints: string[] = [];
  let missing = 0;
  for (let i = 1; i <= options.runsPerReview; i++) {
    try {
      const dir = runPath(options.root, options.base!, review.pmcid, i);
      const score = JSON.parse(readFileSync(join(dir, 'score.json'), 'utf8')) as (StoredScore & { outcome?: SubmissionOutcome }) | null;
      const state = readSubmissionState(dir);
      if (!score || !scoreMatchesSubmission(score, state) || !state.fingerprint || score.outcome?.status !== 'measured'
        || !Array.isArray(score.outcome.capturedPmids)
        || score.outcome.capturedPmids.some((pmid) => typeof pmid !== 'string' || !review.evaluablePmids.includes(pmid))) {
        missing++; continue;
      }
      fingerprints.push(state.fingerprint.querySha256);
      for (const pmid of score.outcome.capturedPmids) captured.add(pmid);
    } catch { missing++; }
  }
  const studies = review.studies.filter((study) => !study.pmids.some((pmid) => captured.has(pmid)))
    .map((study) => ({ study, rank: sha256(`${missedVersion}\n${review.pmcid}\n${study.id}`) }))
    .sort((a, b) => compareText(a.rank, b.rank));
  const fingerprint = sha256([missedVersion, options.base!, String(options.runsPerReview), ...fingerprints,
    JSON.stringify([...review.evaluablePmids].sort(comparePmids)),
    ...[...review.studies].sort((a, b) => compareText(a.id, b.id)).map((study) => JSON.stringify([study.id, [...study.pmids].sort(comparePmids)])),
  ].join('\n'));
  return { candidates: { pmids: studies.map(({ study }) => [...study.pmids].sort(comparePmids)[0]!), fingerprint },
    missing, hasMissed: studies.length > 0 };
}

async function selectSeeds(args: string[], runtime: RunRuntime): Promise<number> {
  const options = parseOptions(args);
  let reviews: ReturnType<typeof targetReviews>;
  try { reviews = targetReviews(options, runtime); }
  catch { throw new Error('対象レビューの記録の読み込みに失敗しました'); }
  let missingScores = 0, reviewsWithMissed = 0;
  const all = reviews.map((review) => {
    if (options.from === 'missed') {
      const result = missedCandidates(review, options);
      missingScores += result.missing;
      if (result.hasMissed) reviewsWithMissed++;
      return { review, candidates: result.candidates, path: join(options.root, '_seeds', options.label, `${review.pmcid}.json`) };
    }
    const dir = join(options.root, '_seed-probe', options.label, review.pmcid);
    let candidates: Candidates | null = null;
    const candidatePath = join(dir, 'candidates-relax-ladder.json'), resultPath = join(dir, 'result-relax-ladder.json');
    if (existsSync(candidatePath) && existsSync(resultPath)) {
      const value = JSON.parse(readFileSync(candidatePath, 'utf8')) as Candidates | null;
      const result = JSON.parse(readFileSync(resultPath, 'utf8')) as { fingerprint?: string } | null;
      if (value && typeof value.fingerprint === 'string' && value.fingerprint && value.fingerprint === result?.fingerprint) {
        if (!Array.isArray(value.pmids) || value.pmids.length > 50 || value.pmids.some((pmid) => typeof pmid !== 'string' || !/^\d+$/.test(pmid))
          || new Set(value.pmids).size !== value.pmids.length) throw new Error('候補の一覧が不正です');
        candidates = value;
      }
    }
    return { review, candidates, path: join(options.root, '_seeds', options.label, `${review.pmcid}.json`) };
  });
  if (missingScores) throw new Error(`採点記録が ${missingScores} 件不足しています`);
  const missing = all.filter((row) => !row.candidates).length;
  if (missing) throw new Error(`候補の一覧が ${missing} 件不足しています`);
  const prepared = all.map((row) => ({ ...row, saved: existsSync(row.path) ? readSeedSelection(row.path) : null }));
  const conflicts = prepared.filter(({ saved, candidates }) => saved && (saved.max !== options.max || saved.candidatesFingerprint !== candidates!.fingerprint)).length;
  if (conflicts) throw new Error(`シードの選定が ${conflicts} 件、別の条件で作られています`);
  const counts = Array<number>(options.max + 1).fill(0);
  for (const { review, candidates, path, saved } of prepared) {
    const pmids: string[] = [], studyIds = new Set<string>(), selectedStudyPmids = new Set<string>();
    if (!saved) {
      for (const pmid of candidates!.pmids) {
        if (!review.evaluablePmids.includes(pmid)) continue;
        const studies = review.studies.filter((study) => study.pmids.includes(pmid));
        if (!studies.length || studies.some((study) => studyIds.has(study.id))) continue;
        if (options.from === 'missed' && studies.some((study) => study.pmids.some((id) => selectedStudyPmids.has(id)))) continue;
        pmids.push(pmid);
        for (const study of studies) studyIds.add(study.id);
        if (options.from === 'missed') for (const study of studies) for (const id of study.pmids) selectedStudyPmids.add(id);
        if (pmids.length === options.max) break;
      }
      mkdirSync(dirname(path), { recursive: true });
      writeJson(path, { pmids, studyIds: [...studyIds], max: options.max, selectedAt: runtime.now().toISOString(), candidatesFingerprint: candidates!.fingerprint });
    }
    counts[(saved?.pmids ?? pmids).length]!++;
  }
  const reportsDir = runtime.reportsDir ?? resolve(__dirname, '../reports');
  mkdirSync(reportsDir, { recursive: true });
  writeJson(join(reportsDir, `seed-select-${options.label}-${options.subset}.json`), {
    label: options.label, subset: options.subset, reviews: reviews.length, max: options.max, generatedAt: runtime.now().toISOString(),
    reviewsBySeedCount: counts, seedsTotal: counts.reduce((sum, count, n) => sum + count * n, 0),
    ...(options.from === 'missed' ? { from: 'missed', base: options.base, runsPerReview: options.runsPerReview, reviewsWithMissed } : {}),
  });
  runtime.stdout(`対象のレビュー: ${reviews.length} 件\n`);
  runtime.stdout(`シード ${counts.map((count, n) => `${n} 本: ${count} 件`).join('、')}\n`);
  return 0;
}

export async function main(args: string[], runtime: RunRuntime = defaultRuntime()): Promise<number> {
  try { return await selectSeeds(args, runtime); }
  catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException)?.code) throw new Error('シードの選定のファイルの読み書きに失敗しました');
    throw error;
  }
}
if (require.main === module) {
  config();
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(redact(String(error), [process.env.NCBI_API_KEY ?? '']) + '\n'); process.exitCode = 1;
  });
}
