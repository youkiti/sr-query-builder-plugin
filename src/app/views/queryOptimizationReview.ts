import { formatLocalized, getUiLanguage, t } from '@/lib/i18n';
import { showConfirmationModal } from '../ui/confirmationModal';
import { renderGenerationNotice } from './generationNotice';
import { blockDiagnosisLines } from '@/features/validation/blockDiagnosis';
import type { OptimizationTrial } from '@/features/formula/skills/optimizeQuery';
import { serializePubmedFormulaMd } from '@/lib/search-formula-md';
import { buildPubmedSearchUrl } from '@/lib/ncbi/pubmedUrl';
import type { QueryOptimizationRunState } from '../store';
import { buildOptimizationReviewSections, evaluateHeldCandidateAdoptionGate, formatLostSampleAnnotation,
  formatUnconfirmedEligibleUpperBound, type ReviewSectionState } from '../services/queryOptimizationReviewSections';

function localizedUnmetReasons(run: QueryOptimizationRunState): string[] {
  const reasons = run.result?.unmetReasons ?? [];
  const messages = run.result?.unmetReasonMessages;
  return messages && messages.length === reasons.length ? messages.map((message) => formatLocalized(getUiLanguage(), message)) : reasons;
}

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
  card.dataset.tour = 'draft-held-candidates';
  card.setAttribute('aria-label', t('draft.review.actionsForHeldCandidate', { candidateId: trial.candidateId }));
  const gate = evaluateHeldCandidateAdoptionGate(trial, run.outsideCheck?.decisions, {
    language: getUiLanguage(),
    bestCapturedPmids: run.result?.best?.measurement.capturedPmids,
    unjudgedSeedPmids: run.outsideCheck?.unjudgedSeedPmids,
  });
  const impact = trial.impact;
  const unconfirmed = impact?.lostHits != null ? impact.lostHits - gate.judgedCount : null;
  const summary = doc.createElement('p');
  summary.textContent = t('draft.review.heldCandidateHitsLostHits', { candidateId: trial.candidateId, lostHits: impact?.lostHits ?? t('draft.review.notMeasured'), gainedHits: impact?.gainedHits ?? t('draft.review.notMeasured') })
    + t('draft.review.judgedUnconfirmed', { judgedCount: gate.judgedCount, unconfirmedCount: unconfirmed ?? t('draft.review.unknown') });
  card.appendChild(summary);
  if (impact?.annotation) {
    const annotation = doc.createElement('p');
    annotation.className = 'optimization__held-annotation';
    annotation.textContent = formatLostSampleAnnotation(impact.annotation, getUiLanguage());
    card.appendChild(annotation);
  }
  const upperBoundText = formatUnconfirmedEligibleUpperBound(trial, getUiLanguage());
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
    adoptButton.textContent = t('draft.review.adoptThisCandidateAndSave');
    adoptButton.setAttribute('aria-label', t('draft.review.adoptHeldCandidateAndSave', { candidateId: trial.candidateId }));
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
  readjustButton.textContent = t('draft.review.reTuneFromThis');
  readjustButton.disabled = !actions.readjustHeld || !!rejected || savingGlobal;
  readjustButton.addEventListener('click', () => { if (!readjustButton.disabled) void actions.readjustHeld?.(trial.candidateId); });
  const rejectButton = doc.createElement('button');
  rejectButton.type = 'button';
  rejectButton.textContent = rejected ? t('draft.review.undoExclusion') : t('draft.review.exclude');
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
    notice.textContent = t('draft.review.savingExclusionChange');
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
    notice.textContent = t('draft.review.aPersonExcludedThisChange', { rejectedAt: rejected.rejectedAt });
    card.appendChild(notice);
  }
  const saveTarget = run.save?.target;
  const isThisSave = saveTarget?.kind === 'held' && saveTarget.candidateId === trial.candidateId;
  if (isThisSave) {
    const status = doc.createElement('p');
    status.setAttribute('aria-live', 'polite');
    status.textContent = run.save?.status === 'saving' ? t('draft.review.saving')
      : run.save?.status === 'saved' ? t('draft.review.savedVersionId', { versionId: String(run.save.formulaVersionId) })
        : run.save?.status === 'error' ? t('draft.review.saveError', { error: String(run.save.error) }) : '';
    card.appendChild(status);
  }
  return card;
}

/**
 * 条件を満たさない結果を保存する前の確認文。自動調整の完了条件（目安件数以下・既知シードの全件捕捉）を
 * 1 つずつ、目安と実測を並べて示す。未測定は「満たさない」と取り違えないよう別に書く。
 */
export function buildAdoptConfirmContent(doc: Document, run: QueryOptimizationRunState): HTMLElement {
  const content = doc.createElement('div');
  const paragraph = (text: string): void => {
    const p = doc.createElement('p');
    p.textContent = text;
    content.appendChild(p);
  };
  paragraph(t('draft.review.thisCandidateDoesNotMeet'));
  const measurement = run.result?.best?.measurement;
  const hits = measurement?.totalHits ?? null;
  const captured = measurement?.capturedPmids?.length ?? null;
  const missed = measurement?.missedPmids?.length ?? null;
  const seedTotal = run.result?.best?.evaluation.seedPmids.length ?? run.seedCount;
  const hitsLine = hits === null
    ? t('draft.review.hitCountAtOrBelow', { targetHits: run.maxHits.toLocaleString() })
    : t('draft.review.hitCountAtOrBelow2', { targetHits: run.maxHits.toLocaleString(), hitCount: hits.toLocaleString() })
      + (hits <= run.maxHits ? t('draft.review.conditionMet') : t('draft.review.hitsAboveTheTarget', { count: (hits - run.maxHits).toLocaleString() }));
  const seedLine = !seedTotal
    ? t('draft.review.captureAllKnownSeedPapers')
    : captured === null || missed === null
      ? t('draft.review.captureAllKnownSeedPapers2', { seedCount: seedTotal })
      : t('draft.review.captureAllKnownSeedPapers3', { seedCount: seedTotal, capturedCount: captured })
        + (missed === 0 ? t('draft.review.conditionMet') : t('draft.review.seedsMissed', { count: missed }));
  const list = doc.createElement('ul');
  for (const line of [hitsLine, seedLine]) {
    const item = doc.createElement('li');
    item.textContent = line;
    list.appendChild(item);
  }
  content.appendChild(list);
  const reasons = localizedUnmetReasons(run);
  if (reasons.length) paragraph(t('draft.review.recordedReasons', { reasons: reasons.join('／') }));
  paragraph(t('draft.review.goingOverTheTargetHit')
    + t('draft.review.meetingEitherConditionDoesNot'));
  paragraph(t('draft.review.saveAfterAPersonHas'));
  return content;
}

/** 最終候補と初期式を直接比較する。却下案や途中で戻した変更は最終差分へ混ぜない。 */
export function renderOptimizationReview(
  container: HTMLElement, run: QueryOptimizationRunState | null, actions: OptimizationReviewActions
): void {
  if (!run || run.status === 'running') return;
  const doc = container.ownerDocument;
  const section = doc.createElement('section');
  section.className = 'optimization__review';
  section.dataset.tour = 'draft-optimize-review';
  section.setAttribute('aria-label', t('draft.review.autoTuningFinalReview'));
  const result = run.result;
  const best = result?.best;
  const heading = doc.createElement('h3');
  const labels = { achieved: t('draft.review.targetHitCountAndKnown'), needs_review: t('draft.review.needsReview'), stopped: t('draft.review.stopped'), error: t('draft.review.error') };
  heading.textContent = t('draft.review.finalReview', { status: labels[result?.status ?? 'error'] });
  section.appendChild(heading);
  const paragraph = (text: string): void => {
    const p = doc.createElement('p');
    p.textContent = text;
    section.appendChild(p);
  };
  if (result?.status === 'achieved') paragraph(t('draft.review.capturingTheKnownSeedsDoes'));
  const subheading = (text: string): void => {
    const h = doc.createElement('h4');
    h.textContent = text;
    section.appendChild(h);
  };
  const diagnosis = result?.blockDiagnosis ?? run.blockDiagnosis;
  if (diagnosis) {
    subheading(t('draft.review.blockStructureDiagnosis'));
    for (const line of blockDiagnosisLines(diagnosis)) paragraph(line);
  }
  if (run.generationNotices) {
    const notice = renderGenerationNotice(doc, run.generationNotices);
    if (notice) {
      subheading(t('draft.review.changesMadeWhenDraftingThe'));
      section.appendChild(notice);
    }
  }
  subheading(t('draft.review.finalFormula'));
  if (best) {
    const formula = doc.createElement('pre');
    formula.className = 'optimization__final-formula';
    formula.textContent = serializePubmedFormulaMd(best.formula);
    section.appendChild(formula);
  } else paragraph(t('draft.review.noMeasuredCandidates'));
  const seeds = best?.evaluation.seedPmids.length ?? run.seedCount;
  const review = buildOptimizationReviewSections(run, getUiLanguage());
  subheading(t('draft.review.checkStatus'));
  const stateLabels: Record<ReviewSectionState, string> = { no_human_decision: t('draft.review.noHumanDecision'), confirmed: t('draft.review.confirmed'), unmet: t('draft.review.unmet'), needs_decision: t('draft.review.awaitingDecision'), decided: t('draft.review.judgedItemsRemain'), unconfirmed: t('draft.review.unconfirmed') };
  for (const item of review.sections) {
    const group = doc.createElement('section');
    group.className = 'optimization__review-section';
    group.dataset.state = item.state;
    const title = doc.createElement('h5');
    title.textContent = `${stateLabels[item.state]}：${item.label}`;
    group.appendChild(title);
    for (const line of item.lines) {
      // 達成時の捕捉の限界は見出し直後に示し、区分内では重複させない。
      if (result?.status === 'achieved' && item.key === 'known_capture' && line === t('draft.reviewSection.captureCaution')) continue;
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
  subheading(t('draft.review.unconfirmedItems'));
  if (!review.unconfirmed.length) paragraph(t('draft.review.noUnconfirmedItems'));
  else {
    const list = doc.createElement('ul');
    for (const text of review.unconfirmed) {
      const item = doc.createElement('li');
      item.textContent = text;
      list.appendChild(item);
    }
    section.appendChild(list);
  }
  subheading(t('draft.review.outsideCheckAndReviewOf'));
  const check = run.outsideCheck;
  if (!check) paragraph(t('draft.review.outsideCheckHasNotRun'));
  else if (check.status !== 'ready') paragraph((check.reasonMessage != null ? formatLocalized(getUiLanguage(), check.reasonMessage) : check.reason) ?? t('draft.review.outsideCheckIsRunning'));
  if (check && !check.candidates.length) paragraph(t('draft.review.noPapersToJudge'));
  for (const candidate of check?.candidates ?? []) {
    const card = doc.createElement('article');
    card.className = 'optimization__candidate';
    card.setAttribute('aria-label', t('draft.review.paperToJudgePmid', { pmid: candidate.pmid }));
    const link = doc.createElement('a');
    link.href = buildPubmedSearchUrl(`${candidate.pmid}[uid]`);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = t('draft.review.article', { pmid: candidate.pmid, year: candidate.year ?? t('draft.review.unknownYear'), title: candidate.title ?? t('draft.review.titleNotRetrieved') });
    card.appendChild(link);
    const source = doc.createElement('p');
    source.textContent = candidate.source === 'outside' ? t('draft.review.outsideTheFormulaAiSelected')
      : t('draft.review.papersLostByHeldCandidate', { candidateId: String(candidate.heldCandidateId) });
    card.appendChild(source);
    if (candidate.source === 'outside') {
      const reason = doc.createElement('p');
      reason.textContent = candidate.reason;
      card.appendChild(reason);
    }
    const details = doc.createElement('details');
    const summary = doc.createElement('summary');
    summary.textContent = t('draft.review.abstract');
    const abstract = doc.createElement('p');
    abstract.textContent = candidate.abstract ?? t('draft.review.abstractNotRetrieved');
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
    status.textContent = selected?.status === 'saving' ? t('draft.review.saving2', { decision: selected.decision })
      : selected?.status === 'saved' ? t('draft.review.saved', { decision: selected.decision })
        : selected?.status === 'error' ? t('draft.review.saveErrorYouCanRetry', { error: String(selected.error) }) : t('draft.review.notJudged');
    card.append(buttons, status);
    section.appendChild(card);
  }
  const decisions = Object.values(check?.decisions ?? {});
  if (decisions.some((item) => item.status === 'saved' && item.decision === 'include')) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.textContent = t('draft.review.reTuneWhileProtectingPapers');
    button.disabled = !actions.readjust || decisions.some((item) => item.status === 'saving') || run.save?.status === 'saving';
    button.addEventListener('click', () => { if (!button.disabled) void actions.readjust?.(); });
    section.appendChild(button);
    paragraph(t('draft.review.theCurrentFinalCandidateWill'));
  }

  subheading(t('draft.review.changesInitialFinalFormula'));
  const initial = run.trials.find((trial) => trial.kind === 'initial')?.formula;
  if (!initial || !best) paragraph(t('draft.review.noInitialOrFinalFormula'));
  else {
    const list = doc.createElement('ul');
    const ids = new Set([...initial.blocks, ...best.formula.blocks].map((block) => block.id));
    for (const id of ids) {
      const before = initial.blocks.find((block) => block.id === id)?.expression;
      const after = best.formula.blocks.find((block) => block.id === id)?.expression;
      if (before === after) continue;
      const item = doc.createElement('li');
      item.textContent = `#${id}: ${before ?? t('draft.review.none')} → ${after ?? t('draft.review.none')}`;
      list.appendChild(item);
    }
    if (initial.combinationExpression !== best.formula.combinationExpression) {
      const item = doc.createElement('li');
      item.textContent = t('draft.review.combination', { before: initial.combinationExpression ?? t('draft.review.none'), after: best.formula.combinationExpression ?? t('draft.review.none') });
      list.appendChild(item);
    }
    if (!list.children.length) paragraph(t('draft.review.noChangesFromTheInitial'));
    else section.appendChild(list);
  }
  subheading(t('draft.review.missedSeedDiagnosis'));
  const diagnoses = result?.seedDiagnoses;
  if (diagnoses === undefined) paragraph(t('draft.review.noMissedSeedDiagnosisRecorded'));
  else if (!diagnoses.length) paragraph(seeds === 0 ? t('draft.review.noDiagnosisBecauseThereAre') : t('draft.review.noMissedSeeds'));
  for (const diagnosis of diagnoses ?? []) {
    const p = doc.createElement('p');
    const link = doc.createElement('a');
    link.textContent = t('draft.review.article', { pmid: diagnosis.pmid, year: diagnosis.year ?? t('draft.review.unknownYear'), title: diagnosis.title ?? t('draft.review.titleNotRetrieved') });
    link.href = buildPubmedSearchUrl(`${diagnosis.pmid}[uid]`);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    p.appendChild(link);
    section.appendChild(p);
    paragraph(diagnosis.note);
  }
  if (diagnoses?.some((diagnosis) => diagnosis.recoverableByTerms === false)) {
    paragraph(t('draft.review.someSeedsCannotBeRecovered'));
    const buttons = doc.createElement('div');
    buttons.className = 'optimization__review-actions';
    const blocks = doc.createElement('button');
    blocks.type = 'button';
    blocks.textContent = t('draft.review.returnToBlockApproval');
    blocks.disabled = !actions.blocks;
    blocks.addEventListener('click', () => actions.blocks?.());
    buttons.appendChild(blocks);
    section.appendChild(buttons);
  }
  subheading(t('draft.review.remainingConcerns'));
  const reasons = run.result ? localizedUnmetReasons(run) : (run.error ? [run.error] : []);
  if (!reasons.length) paragraph(t('draft.review.noUnmetConditionsRecordedCheck'));
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
  adopt.textContent = t('draft.review.adoptAndSave');
  adopt.disabled = !best || !actions.adopt || run.save?.status === 'saving' || run.save?.status === 'saved';
  adopt.addEventListener('click', async () => {
    if (adopt.disabled) return;
    adopt.disabled = true;
    if (result?.status !== 'achieved') {
      const content = buildAdoptConfirmContent(doc, run);
      const accepted = await showConfirmationModal(doc, {
        title: t('draft.review.confirmBeforeSaving'), content, acceptLabel: t('draft.review.saveAfterChecking'), cancelLabel: t('draft.review.cancel'),
      });
      if (!accepted) { adopt.disabled = false; return; }
    }
    void actions.adopt?.();
  });
  const edit = doc.createElement('button');
  edit.type = 'button';
  edit.textContent = t('draft.review.editAndCheck');
  edit.disabled = !best || !actions.edit || run.save?.status === 'saving';
  edit.addEventListener('click', () => actions.edit?.());
  buttons.append(adopt, edit);
  section.appendChild(buttons);
  const status = doc.createElement('p');
  status.className = 'optimization__save-status';
  status.setAttribute('aria-live', 'polite');
  // 保留候補の採用も最良候補の保存も run につき 1 回のため、どちらが保存されたか明示する。
  const savedLabel = run.save?.target?.kind === 'held' ? t('draft.review.formulaFromHeldCandidate', { candidateId: run.save.target.candidateId }) : t('draft.review.bestCandidate');
  status.textContent = run.save?.status === 'saving' ? t('draft.review.saving')
    : run.save?.status === 'saved' ? t('draft.review.adoptedAndSavedVersionId', { candidate: savedLabel, versionId: String(run.save.formulaVersionId) }) : '';
  const error = doc.createElement('p');
  error.className = 'optimization__save-error';
  error.setAttribute('aria-live', 'polite');
  error.textContent = run.save?.error ?? '';
  section.append(status, error);
  container.appendChild(section);
}
