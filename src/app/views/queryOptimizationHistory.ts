import { getUiLanguage, t, type UiLanguage } from '@/lib/i18n';
import type { OptimizationApiEvent, OptimizationMeasurement, OptimizationMeshNode, OptimizationTrial } from '@/features/formula/skills/optimizeQuery';
import { extractBlockTerms } from '@/features/validation/blockTerms';
import { buildPubmedSearchUrl } from '@/lib/ncbi/pubmedUrl';
import type { OptimizationResumeAvailability } from '../services/queryOptimizationCheckpointService';
import { tokenizeExpression } from '@/lib/search-formula-md/expression';
import type { QueryOptimizationRunState, QueryOptimizationSetupState } from '../store';

const hits = (value: number | null | undefined): string => value == null ? t('draft.history.notMeasured') : t('draft.history.hits', { count: value.toLocaleString() });

export function optimizationApiLabel(event: OptimizationApiEvent): string {
  return `${event.source}: ${{ rate_limit: t('draft.history.rateLimiting'), retry: t('draft.history.retrying'), failure: t('draft.history.retrievalFailed') }[event.status]}`;
}

function paragraph(parent: HTMLElement, value: string): void {
  const p = parent.ownerDocument.createElement('p');
  p.textContent = value;
  parent.appendChild(p);
}

function seedCount(measurement: OptimizationMeasurement | null, total: number | null): string {
  return measurement?.capturedPmids == null ? t('draft.history.notMeasured') : t('draft.history.seeds', { capturedCount: measurement.capturedPmids.length, seedCount: total ?? t('draft.history.unknown') });
}

function changedTerms(trial: OptimizationTrial): { label: string; before?: string; after?: string }[] {
  const changes = trial.kind === 'proposal' ? trial.changes : undefined;
  return changes ? [
    ...changes.removedTerms.map((before) => ({ label: t('draft.history.remove'), before })),
    ...changes.addedTerms.map((after) => ({ label: t('draft.history.add'), after })),
    ...changes.replacedTerms.map((term) => ({ label: t('draft.history.revise'), ...term })),
  ] : [];
}

function matchingQuery<T extends { query: string }>(terms: T[], query: string | undefined): T | undefined {
  if (!query) return undefined;
  const exact = terms.find((term) => term.query.trim().toLowerCase() === query.trim().toLowerCase());
  if (exact || query.includes('[')) return exact;
  const bare = (value: string) => value.replace(/\[[^\]]*\]\s*$/, '').trim().replace(/^"|"$/g, '').toLowerCase();
  const matches = terms.filter((term) => bare(term.query) === bare(query));
  // AI がタグを省略した場合も、実測語を一意に特定できるときだけ対応づける。
  return matches.length === 1 ? matches[0] : undefined;
}

function measuredTerm(trial: OptimizationTrial, query: string | undefined, side: 'before' | 'after') {
  return matchingQuery(trial[side]?.terms?.filter((item) => item.blockId === trial.changes?.targetBlockId) ?? [], query);
}

function resolvedQuery(trial: OptimizationTrial, query: string | undefined, side: 'before' | 'after'): string {
  const measured = measuredTerm(trial, query, side);
  if (measured) return measured.query;
  const expression = side === 'after' ? trial.formula.blocks.find((block) => block.id === trial.changes?.targetBlockId)?.expression : '';
  return matchingQuery(tokenizeExpression(expression ?? '').filter((segment) => segment.kind !== 'plain')
    .map((segment) => ({ query: segment.text })), query)?.query ?? query ?? '';
}

function termHits(trial: OptimizationTrial, query: string | undefined, side: 'before' | 'after'): string {
  return hits(measuredTerm(trial, query, side)?.hits);
}

function contribution(trial: OptimizationTrial, query: string | undefined, side: 'before' | 'after'): string {
  return hits(measuredTerm(trial, query, side)?.finalContribution);
}

function meshTermsForChange(trial: OptimizationTrial, change: ReturnType<typeof changedTerms>[number]) {
  return extractBlockTerms(`${resolvedQuery(trial, change.before, 'before')} ${resolvedQuery(trial, change.after, 'after')}`).meshTerms;
}

function relatedMeshNodes(trial: OptimizationTrial, context: OptimizationMeshNode[]): OptimizationMeshNode[] {
  const references = trial.kind === 'information' ? trial.meshRequests ?? []
    : changedTerms(trial).flatMap((change) => meshTermsForChange(trial, change)
      .map((term) => ({ descriptor: term.descriptor, treeNumber: '' })));
  const normalized = (value: string) => value.trim().toLowerCase();
  const targets = context.filter((node) => references.some((ref) =>
    (ref.descriptor && [node.id, node.descriptor, node.label ?? ''].some((value) => normalized(value) === normalized(ref.descriptor)))
    || (ref.treeNumber && node.treeNumbers.includes(ref.treeNumber))));
  // 変更語・要求した枝と、取得済みの直近の親子だけを表示する。
  return context.filter((node) => targets.some((target) => node.id === target.id
    || target.parentIds.includes(node.id) || target.childIds.includes(node.id)
    || node.parentIds.includes(target.id) || node.childIds.includes(target.id)));
}

function renderMeshDetails(mesh: HTMLElement, trial: OptimizationTrial, nodes: OptimizationMeshNode[]): void {
  const heading = mesh.ownerDocument.createElement('h4');
  heading.textContent = 'MeSH';
  mesh.replaceChildren(heading);
  const meshChanges = changedTerms(trial).filter((change) => meshTermsForChange(trial, change).length > 0);
  if (!meshChanges.length) paragraph(mesh, trial.kind === 'information' ? t('draft.history.requestedNearbyMeshTreeContext') : t('draft.history.noMeshChangesRecorded'));
  for (const change of meshChanges) {
    paragraph(mesh, `${change.label}: ${change.before ?? t('draft.history.none')} → ${change.after ?? t('draft.history.none')}`);
    paragraph(mesh, t('draft.history.standaloneHitsBeforeAfter', { before: termHits(trial, change.before, 'before'), after: termHits(trial, change.after, 'after') }));
  }
  if (meshChanges.length || trial.kind === 'information') {
    const edges = new Set<string>();
    for (const parent of nodes) {
      for (const child of nodes.filter((node) => parent.childIds.includes(node.id) || node.parentIds.includes(parent.id))) {
        edges.add(`${parent.label ?? parent.descriptor} → ${child.label ?? child.descriptor}`);
      }
    }
    paragraph(mesh, edges.size ? t('draft.history.retrievedBroaderNarrowerTerms', { terms: [...edges].join(' / ') }) : t('draft.history.parentChildRelationshipsHaveNot'));
    for (const node of nodes) {
      paragraph(mesh, `${node.label ?? node.descriptor}: ${node.treeNumbers.join(', ') || t('draft.history.treeNumbersNotRetrieved')} / explode: ${node.explode ? t('draft.history.yes') : t('draft.history.none')} / ${node.note}`);
    }
    paragraph(mesh, t('draft.history.rationaleAiExplanation', { rationale: trial.rationale || t('draft.history.notRecorded') }));
    paragraph(mesh, t('draft.history.finalFormulaHitsBeforeAnd', { before: hits(trial.before?.totalHits), after: hits(trial.after?.totalHits) }));
  }
}

function renderDetails(details: HTMLElement, trial: OptimizationTrial, nodes: OptimizationMeshNode[]): void {
  const doc = details.ownerDocument;
  const freewordChanges = changedTerms(trial).filter((change) => meshTermsForChange(trial, change).length === 0);
  const group = (label: string): HTMLElement => {
    const section = doc.createElement('section');
    const heading = doc.createElement('h4');
    heading.textContent = label;
    section.appendChild(heading);
    details.appendChild(section);
    return section;
  };
  renderMeshDetails(group('MeSH'), trial, nodes);

  const freewords = group(t('draft.history.freeTextTerms'));
  if (!freewordChanges.length) paragraph(freewords, t('draft.history.noFreeTextChangesRecorded'));
  for (const change of freewordChanges) {
    paragraph(freewords, `${change.label}: ${change.before ?? t('draft.history.none')} → ${change.after ?? t('draft.history.none')}`);
    paragraph(freewords, t('draft.history.standaloneHitsBeforeAfter', { before: termHits(trial, change.before, 'before'), after: termHits(trial, change.after, 'after') }));
    paragraph(freewords, t('draft.history.uniqueContributionToTheFinal', { before: contribution(trial, change.before, 'before'), after: contribution(trial, change.after, 'after') }));
  }
  if (freewordChanges.length) paragraph(freewords, t('draft.history.relationToCriteriaAiExplanation', { rationale: trial.rationale || t('draft.history.notRecorded') }));

  const seeds = group(t('draft.history.seeds2'));
  const before = trial.before?.capturedPmids;
  const after = trial.after?.capturedPmids;
  if (after == null || (trial.before && before == null)) {
    paragraph(seeds, t('draft.history.recoveredAndLostSeedsAre'));
  } else {
    const recovered = after.filter((pmid) => !before?.includes(pmid));
    const lost = (before ?? []).filter((pmid) => !after.includes(pmid));
    for (const [label, pmids] of [
      [trial.accepted ? t('draft.history.recovered') : t('draft.history.recoveredByRejectedCandidateNot'), recovered],
      [trial.accepted ? t('draft.history.lost') : t('draft.history.seedsRestoredAfterALoss'), lost],
    ] as const) {
      if (!pmids.length) continue;
      const p = doc.createElement('p');
      p.append(`${label}: `);
      for (const pmid of pmids) {
        const link = doc.createElement('a');
        link.textContent = `PMID ${pmid}`;
        link.href = buildPubmedSearchUrl(`${pmid}[uid]`);
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        p.append(link, ' ');
      }
      seeds.appendChild(p);
    }
    if (!recovered.length && !lost.length) paragraph(seeds, t('draft.history.noChangeInCapturedSeeds'));
  }
  const captureGroup = group(t('draft.history.seedBlockCaptureTable'));
  const capture = trial.after?.seedCapture;
  if (!capture) paragraph(captureGroup, t('draft.history.captureTableNotMeasuredMeasured'));
  else {
    const wrapper = doc.createElement('div');
    wrapper.className = 'optimization__capture-table';
    const table = doc.createElement('table');
    table.setAttribute('aria-label', t('draft.history.seedBlockCaptureTable'));
    const head = table.createTHead().insertRow();
    for (const label of [t('draft.history.seedPmid'), ...capture.rows.map((row) => `#${row.blockId}`)]) {
      const th = doc.createElement('th');
      th.scope = 'col';
      th.textContent = label;
      head.appendChild(th);
    }
    const body = table.createTBody();
    for (const pmid of capture.seedPmids) {
      const row = body.insertRow();
      const th = doc.createElement('th');
      th.scope = 'row';
      th.textContent = pmid;
      row.appendChild(th);
      for (const block of capture.rows) {
        row.insertCell().textContent = block.capturedPmids === null ? t('draft.history.notMeasured') : block.capturedPmids.includes(pmid) ? '○' : '×';
      }
    }
    wrapper.appendChild(table);
    captureGroup.appendChild(wrapper);
  }
  const deletion = group(t('draft.history.deletionImpactCheck'));
  const impact = trial.impact;
  if (!impact) paragraph(deletion, t('draft.history.rejectedBeforeAdoptionReviewSet'));
  else {
    paragraph(deletion, t('draft.history.lostSetHitsGainedSet', { lostHits: impact.lostHits ?? t('draft.history.notMeasured'), gainedHits: impact.gainedHits ?? t('draft.history.notMeasured') }));
    paragraph(deletion, impact.sample
      ? t('draft.history.samplingMethodSeed', { method: impact.sample.method === 'all' ? t('draft.history.allRandomSampleFromThe') : t('draft.history.retrievedSubsetRandomSampleFrom', { count: impact.sample.retrievedCount }), seed: impact.sample.seed })
      : t('draft.history.samplingMethodLegacyDataFirst'));
    paragraph(deletion, t('draft.history.papersInspectedFullLostSet', { inspectedCount: impact.inspected.length, lostHits: impact.lostHits ?? t('draft.history.notMeasured'), sampleDescription: impact.sample ? t('draft.history.sampledPapers') : t('draft.history.theFirstFewPapers') }));
    for (const article of impact.inspected) {
      const p = doc.createElement('p');
      const link = doc.createElement('a');
      link.textContent = t('draft.history.article', { pmid: article.pmid, year: article.year ?? t('draft.history.unknownYear'), title: article.title ?? t('draft.history.titleNotRetrieved') });
      link.href = buildPubmedSearchUrl(`${article.pmid}[uid]`);
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      p.appendChild(link);
      const annotation = impact.annotation?.items.find((item) => item.pmid === article.pmid);
      if (annotation) {
        const label = { likely_eligible: t('draft.history.likelyEligible'), unclear: t('draft.history.unclear'), likely_ineligible: t('draft.history.likelyIneligible') }[annotation.judgement];
        p.appendChild(doc.createTextNode(t('draft.history.aiAnnotation', { label, reason: annotation.reason })));
      }
      deletion.appendChild(p);
    }
    if (impact.annotation?.status === 'failure') {
      paragraph(deletion, t('draft.history.couldNotRetrieveAiReference', { error: String(impact.annotation.error) }));
    }
    if (impact.error) paragraph(deletion, t('draft.history.measurementOrRetrievalFailed', { error: impact.error }));
  }
  const api = group(t('draft.history.apiWait'));
  if (!trial.apiEvents.length) paragraph(api, t('draft.history.noWaitOrRetrievalFailure'));
  for (const event of trial.apiEvents) paragraph(api, t('draft.history.recordedDuringThisTrial', { event: optimizationApiLabel(event) }));
}

/** データは毎回 state から読む。スクロール位置と開閉状態だけを DOM に保持する。 */
export function createOptimizationHistoryRenderer(): (
  container: HTMLElement, run: QueryOptimizationRunState | null, setup: QueryOptimizationSetupState | null,
  resume?: { availability: OptimizationResumeAvailability;
    start?: () => void; disabled: boolean }
) => void {
  let key = '';
  let section: HTMLElement | null = null;
  let viewport: HTMLElement | null = null;
  let list: HTMLOListElement | null = null;
  let follow = true;
  let scrollTop = 0;
  let renderedContext: OptimizationMeshNode[] | null = null;
  const rows = new Map<string, { element: HTMLLIElement; trial: OptimizationTrial; language: UiLanguage }>();
  return (container, run, setup, resume) => {
    const doc = container.ownerDocument;
    const language = getUiLanguage();
    container.querySelector('.optimization__restored')?.remove();
    if (run) {
      const nextKey = `${run.projectId}:${run.runId}`;
      if (key !== nextKey || !section || !viewport || !list) {
        key = nextKey;
        rows.clear();
        follow = true;
        scrollTop = 0;
        section = doc.createElement('section');
        section.className = 'optimization__history';
        section.dataset.optimizationRun = nextKey;
        section.dataset.tour = 'draft-optimize-history';
        const heading = doc.createElement('h3');
        heading.textContent = t('draft.history.trialHistory');
        section.appendChild(heading);
        viewport = doc.createElement('div');
        viewport.className = 'optimization__history-scroll';
        viewport.tabIndex = 0;
        viewport.setAttribute('role', 'region');
        viewport.setAttribute('aria-label', t('draft.history.autoTuningTrialHistory'));
        viewport.addEventListener('scroll', () => {
          if (!viewport?.isConnected) return;
          scrollTop = viewport.scrollTop;
          follow = viewport.scrollHeight - viewport.clientHeight - scrollTop <= 8;
        });
        list = doc.createElement('ol');
        viewport.appendChild(list);
        section.appendChild(viewport);
      }
      section.querySelector('h3')!.textContent = t('draft.history.trialHistory');
      viewport.setAttribute('aria-label', t('draft.history.autoTuningTrialHistory'));
      let evaluated = 0;
      let added = false;
      const contextChanged = renderedContext !== run.meshContext;
      for (const trial of run.trials) {
        const label = trial.kind === 'initial' ? t('draft.history.initialFormula') : trial.kind === 'final' ? t('draft.history.finalRevalidation')
          : trial.kind === 'information' ? t('draft.history.contextRequest') : trial.kind === 'finish' ? t('draft.history.finishDecision') : t('draft.history.trial', { number: ++evaluated });
        const nodes = relatedMeshNodes(trial, run.meshContext);
        const existing = rows.get(trial.candidateId);
        if (existing && existing.language === language && (existing.trial === trial || JSON.stringify(existing.trial) === JSON.stringify(trial))) {
          if (contextChanged) {
            renderMeshDetails(existing.element.querySelector<HTMLElement>('details > section')!, trial, nodes);
          }
          existing.trial = trial;
          continue;
        }
        const row = doc.createElement('li');
        const outcome = trial.kind === 'information' ? t('draft.history.evaluationDeferred')
          : trial.kind === 'finish' ? (trial.finishRejectedReason ? t('draft.history.finishDecisionNotAccepted') : t('draft.history.finishDecision'))
          : trial.held ? t('draft.history.held') : trial.accepted ? t('draft.history.adopted') : t('draft.history.rejected');
        paragraph(row, t('draft.history.hitsBeforeAndAfterSeeds', { label: label, beforeHits: hits(trial.before?.totalHits), afterHits: hits(trial.after?.totalHits), beforeSeeds: seedCount(trial.before, run.seedCount), afterSeeds: seedCount(trial.after, run.seedCount), outcome: outcome, reason: trial.reason }));
        if (trial.kind === 'information' && trial.informationResult) {
          paragraph(row, t('draft.history.contextRequestAddedToContext', { candidateId: trial.candidateId, obtained: trial.informationResult.obtained, requested: trial.informationResult.requested }));
        }
        if (trial.kind === 'information' && trial.trialDetailIds?.length) {
          paragraph(row, t('draft.history.requestedTrialDetails', { candidateIds: trial.trialDetailIds.join(', ') }));
        }
        if (trial.kind === 'finish' && trial.finishKind) {
          paragraph(row, t('draft.history.finishCategoryThisDecisionAlone', { category: trial.finishKind === 'no_change_needed' ? t('draft.history.noChangesNeeded') : t('draft.history.humanJudgmentNeeded') }));
        }
        if (trial.informedBy) {
          paragraph(row, t('draft.history.decisionAfterReadingContextFrom', { candidateId: trial.informedBy.candidateId, obtained: trial.informedBy.obtained, requested: trial.informedBy.requested }));
        }
        if (trial.rationale) paragraph(row, t('draft.history.reasonForChangeAiExplanation', { rationale: trial.rationale }));
        const details = doc.createElement('details');
        details.open = existing?.element.querySelector('details')?.open ?? false;
        const summary = doc.createElement('summary');
        summary.textContent = t('draft.history.changeDetailsFor', { label: label });
        details.appendChild(summary);
        renderDetails(details, trial, nodes);
        row.appendChild(details);
        if (existing) existing.element.replaceWith(row);
        else { list.appendChild(row); added = true; }
        rows.set(trial.candidateId, { element: row, trial, language });
      }
      renderedContext = run.meshContext;
      if (section.parentElement !== container) container.insertBefore(section, container.children.item(2));
      // 画面全体ではなく履歴領域だけを動かす。新規行がない更新では追従しない。
      viewport.scrollTop = follow && added ? viewport.scrollHeight : scrollTop;
      scrollTop = viewport.scrollTop;
    }
    if (setup?.checkpoint && (!run || run.trials.length === 0)) {
      const checkpoint = setup.checkpoint;
      const restored = doc.createElement('section');
      restored.className = 'optimization__restored';
      const title = doc.createElement('h3');
      title.textContent = checkpoint.status === 'interrupted' ? t('draft.history.interruptedAutoTuningHistory') : t('draft.history.completedAutoTuningHistory');
      restored.appendChild(title);
      paragraph(restored, checkpoint.status === 'interrupted' ? t('draft.history.theRunWasInterruptedIt') : t('draft.history.thisRunHasEnded'));
      paragraph(restored, t('draft.history.savedOnlyTheLogWas', { savedAt: checkpoint.savedAt }));
      if (!run && checkpoint.status === 'interrupted' && resume) {
        const message = doc.createElement('p');
        message.setAttribute('aria-live', 'polite');
        if (resume.availability.available) {
          const remaining = resume.availability.remaining;
          message.textContent = t('draft.history.startANewRunFrom', { apiCalls: remaining.apiCalls, seconds: Math.floor(remaining.elapsedMs / 1000), trials: remaining.evaluatedTrials });
          restored.appendChild(message);
          const button = doc.createElement('button');
          button.type = 'button';
          button.className = 'optimization__resume';
          button.textContent = t('draft.history.resumeFromBestCandidateAnd');
          button.disabled = resume.disabled || !resume.start;
          button.addEventListener('click', () => {
            if (button.disabled) return;
            button.disabled = true;
            resume.start?.();
          });
          restored.appendChild(button);
        } else {
          message.textContent = resume.availability.reason;
          restored.appendChild(message);
        }
      }
      const summaries = doc.createElement('ul');
      for (const trial of checkpoint.trials) {
        const item = doc.createElement('li');
        item.textContent = t('draft.history.seedCapture', { candidateId: trial.candidateId, hits: hits(trial.totalHits), capturedSeeds: trial.capturedSeedCount == null ? t('draft.history.notMeasured') : t('draft.history.seedsTotalNotRecorded', { count: trial.capturedSeedCount }), outcome: trial.held ? t('draft.history.held') : trial.accepted ? t('draft.history.adopted') : t('draft.history.rejected'), reason: trial.reason, lostHits: trial.lostHits !== undefined ? t('draft.history.hitsLost', { count: trial.lostHits ?? t('draft.history.notMeasured') }) : '' });
        summaries.appendChild(item);
      }
      restored.appendChild(summaries);
      container.appendChild(restored);
    }
  };
}
