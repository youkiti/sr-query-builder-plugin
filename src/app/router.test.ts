import {
  DEFAULT_ROUTE,
  ROUTES,
  ROUTE_LABELS,
  buildHash,
  createLocationRouterDeps,
  parseRoute,
} from './router';

describe('parseRoute', () => {
  test.each(ROUTES.map((r) => [`#/${r}`, r] as const))('%s → %s', (hash, expected) => {
    expect(parseRoute(hash)).toBe(expected);
  });

  test('空ハッシュは DEFAULT_ROUTE', () => {
    expect(parseRoute('')).toBe(DEFAULT_ROUTE);
  });

  test('# のみは DEFAULT_ROUTE', () => {
    expect(parseRoute('#')).toBe(DEFAULT_ROUTE);
  });

  test('未知ルートは DEFAULT_ROUTE', () => {
    expect(parseRoute('#/unknown')).toBe(DEFAULT_ROUTE);
  });
});

describe('buildHash', () => {
  test('ルート名から #/<name> を作る', () => {
    expect(buildHash('seeds')).toBe('#/seeds');
  });
});

describe('ROUTE_LABELS', () => {
  test('全ルートに日本語ラベルが付く', () => {
    for (const route of ROUTES) {
      expect(ROUTE_LABELS[route].length).toBeGreaterThan(0);
    }
  });
});

describe('createLocationRouterDeps', () => {
  test('window から getHash / onHashChange を作る', () => {
    const addSpy = jest.fn();
    const removeSpy = jest.fn();
    const win = {
      location: { hash: '#/edit' },
      addEventListener: addSpy,
      removeEventListener: removeSpy,
    } as unknown as Window;
    const deps = createLocationRouterDeps(win);
    expect(deps.getHash()).toBe('#/edit');
    const listener = jest.fn();
    const off = deps.onHashChange(listener);
    expect(addSpy).toHaveBeenCalledWith('hashchange', listener);
    off();
    expect(removeSpy).toHaveBeenCalledWith('hashchange', listener);
  });
});
