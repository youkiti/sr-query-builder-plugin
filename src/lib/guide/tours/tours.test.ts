import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { GUIDE_TOURS, GUIDE_TOUR_IDS, isGuideTourId, stepKey, tourDescKey, tourKeyBase, tourTitleKey } from './index';
import { ja } from '../../i18n/ja';
import { en } from '../../i18n/en';
import { ROUTES } from '../../../app/router';

test('登録 ID と定義は一致し、未知の値や継承プロパティを ID と認めない', () => {
  expect(GUIDE_TOUR_IDS).toEqual(['getting-started']);
  for (const [id, tour] of Object.entries(GUIDE_TOURS)) {
    expect(tour.id).toBe(id);
    expect(isGuideTourId(id)).toBe(true);
  }
  for (const value of [undefined, null, 1, 'unknown', 'toString']) expect(isGuideTourId(value)).toBe(false);
});

test('文言キーは ID から PascalCase で作られる（語が 1 つでも複数でも）', () => {
  expect(tourKeyBase('getting-started')).toBe('guide.tourGettingStarted');
  expect(tourKeyBase('schema')).toBe('guide.tourSchema');
  const base = tourKeyBase('getting-started');
  expect(tourTitleKey(base)).toBe('guide.tourGettingStartedTitle');
  expect(tourDescKey(base)).toBe('guide.tourGettingStartedDesc');
  expect(stepKey(base, 'open-protocol')).toBe('guide.tourGettingStartedStepOpenProtocol');
  expect(stepKey(base, 'welcome')).toBe('guide.tourGettingStartedStepWelcome');
});

test('見出し・説明・各手順の本文が日英の辞書にあり、手順 ID は重複せず、最後の手順は next で終わる', () => {
  for (const tour of Object.values(GUIDE_TOURS)) {
    const base = tourKeyBase(tour.id);
    expect(tour.titleKey).toBe(tourTitleKey(base));
    expect(tour.descriptionKey).toBe(tourDescKey(base));
    expect(tour.steps.length).toBeGreaterThan(0);
    expect(new Set(tour.steps.map(step => step.id)).size).toBe(tour.steps.length);
    for (const step of tour.steps) expect(step.textKey).toBe(stepKey(base, step.id));
    for (const key of [tour.titleKey, tour.descriptionKey, ...tour.steps.map(step => step.textKey)]) {
      for (const dict of [ja, en] as Array<Record<string, string>>) {
        expect(Object.prototype.hasOwnProperty.call(dict, key)).toBe(true);
        expect(dict[key]!.length).toBeGreaterThan(0);
      }
    }
    expect(tour.steps[tour.steps.length - 1]!.advance.type).toBe('next');
  }
});

test('最後の手順は、ヘッダーの「ツアー」ボタン（tour-list）を指す', () => {
  for (const tour of Object.values(GUIDE_TOURS)) {
    expect(tour.steps[tour.steps.length - 1]!.target).toBe('tour-list');
  }
});

function sourceFiles(directory: string): Array<{ path: string; text: string }> {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!/\.(ts|html)$/.test(entry.name) || /\.test\.ts$/.test(entry.name)) return [];
    return [{ path, text: readFileSync(path, 'utf8') }];
  });
}

test('全ツアーの全手順の対象が、画面側の data-tour に実在する', () => {
  const sources = sourceFiles(join(process.cwd(), 'src/app')).map(file => file.text).join('\n');
  const targets = new Set<string>([
    ...Array.from(sources.matchAll(/data-tour="([^"]+)"/g), match => match[1]!),
    ...Array.from(sources.matchAll(/dataset\.tour = '([^']+)'/g), match => match[1]!),
  ]);
  // 実行時に組み立てる値の規則: サイドバーのボタンは `nav-` + ルート名（bootstrap.ts の renderSidebar が付ける）。
  expect(sources).toContain('btn.dataset.tour = `nav-${route}`');
  for (const route of ROUTES) targets.add(`nav-${route}`);
  for (const tour of Object.values(GUIDE_TOURS)) {
    for (const step of tour.steps) {
      expect([step.id, step.target, targets.has(step.target)]).toEqual([step.id, step.target, true]);
      if (step.route !== undefined) expect(ROUTES.map(route => `#/${route}`)).toContain(step.route);
    }
  }
});

test('ja と en の辞書は同じキー集合を持つ', () => {
  expect(Object.keys(en).sort()).toEqual(Object.keys(ja).sort());
});
