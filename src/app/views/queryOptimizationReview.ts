import { renderGenerationNotice } from './generationNotice';
import { blockDiagnosisLines } from '@/features/validation/blockDiagnosis';
import type { OptimizationTrial } from '@/features/formula/skills/optimizeQuery';
import { serializePubmedFormulaMd } from '@/lib/search-formula-md';
import { buildPubmedSearchUrl } from '@/lib/ncbi/pubmedUrl';
import type { QueryOptimizationRunState } from '../store';
import { buildOptimizationReviewSections, evaluateHeldCandidateAdoptionGate, formatLostSampleAnnotation,
  formatUnconfirmedEligibleUpperBound, type ReviewSectionState } from '../services/queryOptimizationReviewSections';

export interface OptimizationReviewActions {
  adopt: (() => Promise<void>) | undefined;
  edit: (() => void) | undefined;
  blocks: (() => void) | undefined;
  decide?: (pmid: string, decision: 'include' | 'exclude' | 'maybe') => Promise<void>;
  readjust?: () => Promise<void>;
  /** 保留候補（issue #172）を採用して保存する。ゲート未達・除外済みの判定は呼び出し先が行う。 */
  adoptHeld?: (candidateId: string) => Promise<void>;
  /** 保留候補の式を初期式にして再調整を始める。 */
  readjustHeld?: (candidateId: string) => Promise<void>;
  /** 保留候補を人が「除外」する。 */
  rejectHeld?: (candidateId: string) => void;
  /** 「除外」を取り消す。 */
  undoRejectHeld?: (candidateId: string) => void;
}

/**
 * 保留候補ごとの 3 操作カード（issue #172）。「削除影響の確認」区分の該当行の直後に置く。
 * 押せる／押せないの判定は evaluateHeldCandidateAdoptionGate だけを根拠にし、view 側で
 * 別の条件を作らない（採用ゲート・除外の意味を 1 箇所に保つ）。
 */
function renderHeldCandidateCard(
  doc: Document, run: QueryOptimizationRunState, trial: OptimizationTrial, actions: OptimizationReviewActions
): HTMLElement {
  const card = doc.createElement('article');
  card.className = 'optimization__held-candidate';
  card.setAttribute('aria-label', `保留候補 ${trial.candidateId} の操作`);
  const gate = evaluateHeldCandidateAdoptionGate(trial, run.outsideCheck?.decisions, {
    bestCapturedPmids: run.result?.best?.measurement.capturedPmids,
    unjudgedSeedPmids: run.outsideCheck?.unjudgedSeedPmids,
  });
  const impact = trial.impact;
  const unconfirmed = impact?.lostHits != null ? impact.lostHits - gate.judgedCount : null;
  const summary = doc.createElement('p');
  summary.textContent = `保留候補 ${trial.candidateId}: 失う ${impact?.lostHits ?? '未測定'} 件・増える ${impact?.gainedHits ?? '未測定'} 件・`
    + `判定済み ${gate.judgedCount} 件・未確認 ${unconfirmed ?? '不明'} 件`;
  card.appendChild(summary);
  if (impact?.annotation) {
    const annotation = doc.createElement('p');
    annotation.className = 'optimization__held-annotation';
    annotation.textContent = formatLostSampleAnnotation(impact.annotation);
    card.appendChild(annotation);
  }
  const upperBoundText = formatUnconfirmedEligibleUpperBound(trial);
  if (upperBoundText) {
    const upperBound = doc.createElement('p');
    upperBound.className = 'optimization__held-upper-bound';
    upperBound.textContent = upperBoundText;
    card.appendChild(upperBound);
  }
  const rejected = run.heldRejections?.[trial.candidateId];
  const savingGlobal = run.save?.status === 'saving';
  const buttons = doc.createElement('div');
  buttons.className = 'optimization__review-actions';
  // 失う集合が上限を超える候補は、判定によらず「採用して保存」自体を出さない（再調整・除外は出す）。
  if (!gate.exceedsMaxLostHits) {
    const adoptButton = doc.createElement('button');
    adoptButton.type = 'button';
    adoptButton.textContent = 'この候補を採用して保存';
    adoptButton.setAttribute('aria-label', `保留候補 ${trial.candidateId} を採用して保存`);
    adoptButton.disabled = !actions.adoptHeld || !!rejected || !gate.allowed
      || run.save?.status === 'saving' || run.save?.status === 'saved';
    adoptButton.addEventListener('click', () => {
      if (adoptButton.disabled) return;
      adoptButton.disabled = true;
      void actions.adoptHeld?.(trial.candidateId);
    });
    buttons.appendChild(adoptButton);
  }
  const readjustButton = doc.createElement('button');
  readjustButton.type = 'button';
  readjustButton.textContent = 'これを初期式に再調整';
  readjustButton.disabled = !actions.readjustHeld || !!rejected || savingGlobal;
  readjustButton.addEventListener('click', () => { if (!readjustButton.disabled) void actions.readjustHeld?.(trial.candidateId); });
  const rejectButton = doc.createElement('button');
  rejectButton.type = 'button';
  rejectButton.textContent = rejected ? '除外を取り消す' : '除外';
  rejectButton.disabled = !!run.heldRejectionSaving || (rejected ? !actions.undoRejectHeld : !actions.rejectHeld);
  rejectButton.addEventListener('click', () => {
    if (rejectButton.disabled) return;
    if (rejected) actions.undoRejectHeld?.(trial.candidateId); else actions.rejectHeld?.(trial.candidateId);
  });
  buttons.append(readjustButton, rejectButton);
  card.appendChild(buttons);
  if (run.heldRejectionSaving) {
    const notice = doc.createElement('p');
    notice.setAttribute('role', 'status');
    notice.textContent = '除外・取り消しを保存中…';
    card.appendChild(notice);
  }
  if (!gate.allowed && gate.reason) {
    const reason = doc.createElement('p');
    reason.className = 'optimization__held-gate-reason';
    reason.textContent = gate.reason;
    card.appendChild(reason);
  }
  if (rejected) {
    const notice = doc.createElement('p');
    notice.textContent = `人がこの変更を除外しました（${rejected.rejectedAt}）。次にこの run を再開すると、この式は測定せずに却下されます。`;
    card.appendChild(notice);
  }
  const saveTarget = run.save?.target;
  const isThisSave = saveTarget?.kind === 'held' && saveTarget.candidateId === trial.candidateId;
  if (isThisSave) {
    const status = doc.createElement('p');
    status.setAttribute('aria-live', 'polite');
    status.textContent = run.save?.status === 'saving' ? '保存中…'
      : run.save?.status === 'saved' ? `保存しました（version_id: ${run.save.formulaVersionId}）`
        : run.save?.status === 'error' ? `保存エラー：${run.save.error}` : '';
    card.appendChild(status);
  }
  return card;
}

/** 最終候補と初期式を直接比較する。却下案や途中で戻した変更は最終差分へ混ぜない。 */
export function renderOptimizationReview(
  container: HTMLElement, run: QueryOptimizationRunState | null, actions: OptimizationReviewActions
): void {
  if (!run || run.status === 'running') return;
  const doc = container.ownerDocument;
  const section = doc.createElement('section');
  section.className = 'optimization__review';
  section.setAttribute('aria-label', '自動調整の最終レビュー');
  const result = run.result;
  const best = result?.best;
  const heading = doc.createElement('h3');
  const labels = { achieved: '目安件数と既知シードの捕捉を満たしました', needs_review: '要確認', stopped: '停止', error: 'エラー' };
  heading.textContent = `最終レビュー：${labels[result?.status ?? 'error']}`;
  section.appendChild(heading);
  const paragraph = (text: string): void => {
    const p = doc.createElement('p');
    p.textContent = text;
    section.appendChild(p);
  };
  if (result?.status === 'achieved') paragraph('既知シードを捕捉したことは、未知の適格研究を網羅したことを意味しません。');
  const subheading = (text: string): void => {
    const h = doc.createElement('h4');
    h.textContent = text;
    section.appendChild(h);
  };
  const diagnosis = result?.blockDiagnosis ?? run.blockDiagnosis;
  if (diagnosis) {
    subheading('ブロック構造の診断');
    for (const line of blockDiagnosisLines(diagnosis)) paragraph(line);
  }
  if (run.generationNotices) {
    const notice = renderGenerationNotice(doc, run.generationNotices);
    if (notice) {
      subheading('初期式の生成で行った変更');
      section.appendChild(notice);
    }
  }
  subheading('最終式');
  if (best) {
    const formula = doc.createElement('pre');
    formula.className = 'optimization__final-formula';
    formula.textContent = serializePubmedFormulaMd(best.formula);
    section.appendChild(formula);
  } else paragraph('実測済みの候補がありません。');
  const seeds = best?.evaluation.seedPmids.length ?? run.seedCount;
  const review = buildOptimizationReviewSections(run);
  subheading('確認の状況');
  const stateLabels: Record<ReviewSectionState, string> = { confirmed: '確認済み', unmet: '未達', needs_decision: '判定待ち', decided: '判定済み（残件あり）', unconfirmed: '未確認' };
  for (const item of review.sections) {
    const group = doc.createElement('section');
    group.className = 'optimization__review-section';
    group.dataset.state = item.state;
    const title = doc.createElement('h5');
    title.textContent = `${stateLabels[item.state]}：${item.label}`;
    group.appendChild(title);
    for (const line of item.lines) {
      // 達成時の捕捉の限界は見出し直後に示し、区分内では重複させない。
      if (result?.status === 'achieved' && item.key === 'known_capture' && line.startsWith('既知シードの捕捉は、')) continue;
      const p = doc.createElement('p');
      p.textContent = line;
      group.appendChild(p);
    }
    // 保留候補ごとの 3 操作（issue #172）は「削除影響の確認」区分の直後に、
    // その候補の失う件数・判定状況が見える状態で出す。
    if (item.key === 'deletion_impact') {
      for (const trial of run.trials.filter((candidate) => candidate.held)) {
        group.appendChild(renderHeldCandidateCard(doc, run, trial, actions));
      }
    }
    section.appendChild(group);
  }
  subheading('未確認事項');
  if (!review.unconfirmed.length) paragraph('未確認事項はありません');
  else {
    const list = doc.createElement('ul');
    for (const text of review.unconfirmed) {
      const item = doc.createElement('li');
      item.textContent = text;
      list.appendChild(item);
    }
    section.appendChild(list);
  }
  subheading('外側の確認と失う文献の判定');
  const check = run.outsideCheck;
  if (!check) paragraph('外側の確認は未実行です');
  else if (check.status !== 'ready') paragraph(check.reason ?? '外側の確認を実行中です');
  if (check && !check.candidates.length) paragraph('判定候補はありません');
  for (const candidate of check?.candidates ?? []) {
    const card = doc.createElement('article');
    card.className = 'optimization__candidate';
    card.setAttribute('aria-label', `判定候補 PMID ${candidate.pmid}`);
    const link = doc.createElement('a');
    link.href = buildPubmedSearchUrl(`${candidate.pmid}[uid]`);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = `PMID ${candidate.pmid}（${candidate.year ?? '年不明'}）${candidate.title ?? 'タイトル未取得'}`;
    card.appendChild(link);
    const source = doc.createElement('p');
    source.textContent = candidate.source === 'outside' ? '式の外側（AI が選んだ境界事例）'
      : `保留候補 ${candidate.heldCandidateId} で失う文献`;
    card.appendChild(source);
    if (candidate.source === 'outside') {
      const reason = doc.createElement('p');
      reason.textContent = candidate.reason;
      card.appendChild(reason);
    }
    const details = doc.createElement('details');
    const summary = doc.createElement('summary');
    summary.textContent = '抄録';
    const abstract = doc.createElement('p');
    abstract.textContent = candidate.abstract ?? '抄録は取得されていません';
    details.append(summary, abstract);
    card.appendChild(details);
    const selected = check?.decisions[candidate.pmid];
    const buttons = doc.createElement('div');
    buttons.className = 'optimization__review-actions';
    for (const decision of ['include', 'exclude', 'maybe'] as const) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.textContent = decision;
      button.setAttribute('aria-pressed', String(selected?.decision === decision));
      button.disabled = !actions.decide || selected?.status === 'saving' || selected?.status === 'saved';
      button.addEventListener('click', () => {
        if (!button.disabled) void actions.decide?.(candidate.pmid, decision);
      });
      buttons.appendChild(button);
    }
    const status = doc.createElement('p');
    status.setAttribute('aria-live', 'polite');
    status.textContent = selected?.status === 'saving' ? `${selected.decision} を保存中…`
      : selected?.status === 'saved' ? `${selected.decision}：保存済み`
        : selected?.status === 'error' ? `保存エラー：${selected.error}（再試行できます）` : '未判定';
    card.append(buttons, status);
    section.appendChild(card);
  }
  const decisions = Object.values(check?.decisions ?? {});
  if (decisions.some((item) => item.status === 'saved' && item.decision === 'include')) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.textContent = 'include した文献を保護して再調整する';
    button.disabled = !actions.readjust || decisions.some((item) => item.status === 'saving') || run.save?.status === 'saving';
    button.addEventListener('click', () => { if (!button.disabled) void actions.readjust?.(); });
    section.appendChild(button);
    paragraph('現在の最終候補は保存されません。残す場合は先に「採用して保存」してください');
  }

  subheading('変更一覧（初期式 → 最終式）');
  const initial = run.trials.find((trial) => trial.kind === 'initial')?.formula;
  if (!initial || !best) paragraph('比較できる初期式または最終式がありません。');
  else {
    const list = doc.createElement('ul');
    const ids = new Set([...initial.blocks, ...best.formula.blocks].map((block) => block.id));
    for (const id of ids) {
      const before = initial.blocks.find((block) => block.id === id)?.expression;
      const after = best.formula.blocks.find((block) => block.id === id)?.expression;
      if (before === after) continue;
      const item = doc.createElement('li');
      item.textContent = `#${id}: ${before ?? 'なし'} → ${after ?? 'なし'}`;
      list.appendChild(item);
    }
    if (initial.combinationExpression !== best.formula.combinationExpression) {
      const item = doc.createElement('li');
      item.textContent = `結合式: ${initial.combinationExpression ?? 'なし'} → ${best.formula.combinationExpression ?? 'なし'}`;
      list.appendChild(item);
    }
    if (!list.children.length) paragraph('初期式からの変更はありません。');
    else section.appendChild(list);
  }
  subheading('未捕捉シードの診断');
  const diagnoses = result?.seedDiagnoses;
  if (diagnoses === undefined) paragraph('未捕捉シードの診断は記録されていません');
  else if (!diagnoses.length) paragraph(seeds === 0 ? '検証対象シードがないため診断はありません' : '未捕捉シードはありません');
  for (const diagnosis of diagnoses ?? []) {
    const p = doc.createElement('p');
    const link = doc.createElement('a');
    link.textContent = `PMID ${diagnosis.pmid}（${diagnosis.year ?? '年不明'}）${diagnosis.title ?? 'タイトル未取得'}`;
    link.href = buildPubmedSearchUrl(`${diagnosis.pmid}[uid]`);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    p.appendChild(link);
    section.appendChild(p);
    paragraph(diagnosis.note);
  }
  if (diagnoses?.some((diagnosis) => diagnosis.recoverableByTerms === false)) {
    paragraph('語の調整では回収できないシードがあります。検索概念・フィルタが強すぎる可能性があるため、ブロック承認で見直してください。');
    const buttons = doc.createElement('div');
    buttons.className = 'optimization__review-actions';
    const blocks = doc.createElement('button');
    blocks.type = 'button';
    blocks.textContent = 'ブロック承認へ戻る';
    blocks.disabled = !actions.blocks;
    blocks.addEventListener('click', () => actions.blocks?.());
    buttons.appendChild(blocks);
    section.appendChild(buttons);
  }
  subheading('残った懸念');
  const reasons = result?.unmetReasons ?? (run.error ? [run.error] : []);
  if (!reasons.length) paragraph('記録された未達理由はありません。研究基準との整合性を最後に確認してください。');
  else {
    const list = doc.createElement('ul');
    for (const reason of reasons) {
      const item = doc.createElement('li');
      item.textContent = reason;
      list.appendChild(item);
    }
    section.appendChild(list);
  }
  const buttons = doc.createElement('div');
  buttons.className = 'optimization__review-actions';
  const adopt = doc.createElement('button');
  adopt.type = 'button';
  adopt.textContent = '採用して保存';
  adopt.disabled = !best || !actions.adopt || run.save?.status === 'saving' || run.save?.status === 'saved';
  adopt.addEventListener('click', () => {
    if (adopt.disabled) return;
    adopt.disabled = true;
    void actions.adopt?.();
  });
  const edit = doc.createElement('button');
  edit.type = 'button';
  edit.textContent = '編集して確認';
  edit.disabled = !best || !actions.edit || run.save?.status === 'saving';
  edit.addEventListener('click', () => actions.edit?.());
  buttons.append(adopt, edit);
  section.appendChild(buttons);
  const status = doc.createElement('p');
  status.className = 'optimization__save-status';
  status.setAttribute('aria-live', 'polite');
  // 保留候補の採用も最良候補の保存も run につき 1 回のため、どちらが保存されたか明示する。
  const savedLabel = run.save?.target?.kind === 'held' ? `保留候補 ${run.save.target.candidateId} の式` : '最良候補';
  status.textContent = run.save?.status === 'saving' ? '保存中…'
    : run.save?.status === 'saved' ? `${savedLabel}を採用して保存しました（version_id: ${run.save.formulaVersionId}）` : '';
  const error = doc.createElement('p');
  error.className = 'optimization__save-error';
  error.setAttribute('aria-live', 'polite');
  error.textContent = run.save?.error ?? '';
  section.append(status, error);
  container.appendChild(section);
}
