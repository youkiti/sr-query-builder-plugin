import {
  clearCurrentProject,
  createChromeStoreDeps,
  getCurrentProject,
  getRecentProjects,
  setCurrentProject,
  type CurrentProjectEntry,
} from './projectStore';

function makeMemoryStore(): {
  deps: Parameters<typeof setCurrentProject>[1];
  data: Record<string, unknown>;
} {
  const data: Record<string, unknown> = {};
  return {
    data,
    deps: {
      read: async <T>(key: string) => data[key] as T | undefined,
      write: async (items) => {
        Object.assign(data, items);
      },
    },
  };
}

const entry = (id: string, title = 't'): CurrentProjectEntry => ({
  projectId: id,
  spreadsheetId: `s-${id}`,
  driveFolderId: `d-${id}`,
  title,
});

describe('setCurrentProject', () => {
  test('currentProject と recentProjects 先頭に追加する', async () => {
    const { deps, data } = makeMemoryStore();
    await setCurrentProject(entry('A'), deps);
    expect(data['currentProject']).toEqual(entry('A'));
    expect(data['recentProjects']).toEqual([entry('A')]);
  });

  test('既存の同 projectId は重複させず先頭に上げる', async () => {
    const { deps } = makeMemoryStore();
    await setCurrentProject(entry('A'), deps);
    await setCurrentProject(entry('B'), deps);
    await setCurrentProject(entry('A', 'updated'), deps);
    const recent = await getRecentProjects(deps);
    expect(recent.map((r) => r.projectId)).toEqual(['A', 'B']);
    expect(recent[0]?.title).toBe('updated');
  });

  test('最新 10 件を超えると古いものが切り落とされる', async () => {
    const { deps } = makeMemoryStore();
    for (let i = 0; i < 12; i += 1) {
      await setCurrentProject(entry(`P${i}`), deps);
    }
    const recent = await getRecentProjects(deps);
    expect(recent).toHaveLength(10);
    expect(recent[0]?.projectId).toBe('P11');
    expect(recent[recent.length - 1]?.projectId).toBe('P2');
  });
});

describe('getCurrentProject / getRecentProjects', () => {
  test('未設定なら undefined / []', async () => {
    const { deps } = makeMemoryStore();
    await expect(getCurrentProject(deps)).resolves.toBeUndefined();
    await expect(getRecentProjects(deps)).resolves.toEqual([]);
  });
});

describe('clearCurrentProject', () => {
  test('currentProject を null にする', async () => {
    const { deps, data } = makeMemoryStore();
    await setCurrentProject(entry('A'), deps);
    await clearCurrentProject(deps);
    expect(data['currentProject']).toBeNull();
  });
});

describe('createChromeStoreDeps', () => {
  test('read は chrome.storage.local.get の値を返す', async () => {
    (globalThis as unknown as { chrome: typeof chrome }).chrome = {
      storage: {
        local: {
          get: jest.fn().mockResolvedValue({ currentProject: entry('Z') }),
          set: jest.fn().mockResolvedValue(undefined),
        },
      },
    } as unknown as typeof chrome;
    const deps = createChromeStoreDeps();
    await expect(deps.read('currentProject')).resolves.toEqual(entry('Z'));
  });

  test('write は chrome.storage.local.set に委譲する', async () => {
    const set = jest.fn().mockResolvedValue(undefined);
    (globalThis as unknown as { chrome: typeof chrome }).chrome = {
      storage: {
        local: {
          get: jest.fn().mockResolvedValue({}),
          set,
        },
      },
    } as unknown as typeof chrome;
    const deps = createChromeStoreDeps();
    await deps.write({ a: 1 });
    expect(set).toHaveBeenCalledWith({ a: 1 });
  });
});
