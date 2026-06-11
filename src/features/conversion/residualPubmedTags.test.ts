import { detectResidualPubmedTags } from './residualPubmedTags';

describe('detectResidualPubmedTags', () => {
  test('語に後置された [pt] / [sh] / [mh] を検出する', () => {
    const tags = detectResidualPubmedTags(
      'randomized controlled trial[pt] OR drug therapy[sh] OR animals[mh]'
    );
    expect(tags).toEqual(['[pt]', '[sh]', '[mh]']);
  });

  test('Cochrane 形 [mh "Descriptor"] は誤検出しない', () => {
    const tags = detectResidualPubmedTags('[mh "Diabetes Mellitus"] AND [mh "Aspirin"]');
    expect(tags).toEqual([]);
  });

  test('後置形 [mh] と Cochrane 形 [mh "X"] が混在しても後置形だけ拾う', () => {
    const tags = detectResidualPubmedTags('[mh "Diabetes"] OR animals[mh]');
    expect(tags).toEqual(['[mh]']);
  });

  test('同じタグは重複排除する', () => {
    const tags = detectResidualPubmedTags('a[pt] OR b[pt]');
    expect(tags).toEqual(['[pt]']);
  });

  test(':NoExp 等の修飾が付いても [mesh] へ正規化する', () => {
    const tags = detectResidualPubmedTags('"Aspirin"[mesh:NoExp]');
    expect(tags).toEqual(['[mesh]']);
  });

  test('残存タグが無ければ空配列', () => {
    const tags = detectResidualPubmedTags('"heart failure":ti,ab,kw AND [mh "Diabetes"]');
    expect(tags).toEqual([]);
  });
});
