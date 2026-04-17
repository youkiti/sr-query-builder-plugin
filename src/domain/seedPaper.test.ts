import { isSeedEligibleForValidation, type SeedPaper } from './seedPaper';

function buildSeed(overrides: Partial<SeedPaper> = {}): SeedPaper {
  return {
    pmid: '12345',
    title: 'test',
    year: 2024,
    source: 'initial',
    ingestFormat: 'pmid_direct',
    originalDb: null,
    isValid: true,
    exclusionReason: null,
    originalPayloadRef: null,
    userDecision: null,
    decidedAt: null,
    decidedBy: null,
    note: null,
    ...overrides,
  };
}

describe('isSeedEligibleForValidation', () => {
  test('is_valid=true かつ PMID あり、user_decision=null / include は対象', () => {
    expect(isSeedEligibleForValidation(buildSeed())).toBe(true);
    expect(isSeedEligibleForValidation(buildSeed({ userDecision: 'include' }))).toBe(true);
  });

  test('is_valid=false は対象外', () => {
    expect(
      isSeedEligibleForValidation(
        buildSeed({ isValid: false, exclusionReason: 'pmid_not_found' })
      )
    ).toBe(false);
  });

  test('pmid=null は対象外（is_valid=false の典型ケース）', () => {
    expect(
      isSeedEligibleForValidation(
        buildSeed({
          pmid: null,
          isValid: false,
          ingestFormat: 'ris_no_pmid',
          exclusionReason: 'no_pmid_resolved',
        })
      )
    ).toBe(false);
  });

  test('pmid=null だが is_valid=true という不整合な状態でも防御的に false を返す', () => {
    expect(isSeedEligibleForValidation(buildSeed({ pmid: null }))).toBe(false);
  });

  test('user_decision=exclude / maybe は対象外', () => {
    expect(isSeedEligibleForValidation(buildSeed({ userDecision: 'exclude' }))).toBe(false);
    expect(isSeedEligibleForValidation(buildSeed({ userDecision: 'maybe' }))).toBe(false);
  });
});
