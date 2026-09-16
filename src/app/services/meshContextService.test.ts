import { fetchMeshContext } from './meshContextService';
import { fetchMeshTreeNumbers, fetchMeshLabels, fetchMeshChildren } from '@/lib/ncbi';

jest.mock('@/lib/ncbi', () => ({ fetchMeshTreeNumbers: jest.fn(), fetchMeshLabels: jest.fn(), fetchMeshChildren: jest.fn() }));
const tree = jest.mocked(fetchMeshTreeNumbers);
const labels = jest.mocked(fetchMeshLabels);
const children = jest.mocked(fetchMeshChildren);
const eutils = { fetch: jest.fn() };

beforeEach(() => jest.resetAllMocks());

test('最大 3 枝に制限し、取得した親子と枝をまとめる', async () => {
  tree.mockResolvedValue({ trees: new Map([['term', ['A01', 'A02', 'A03', 'A04']]]), reasons: new Map() });
  labels.mockImplementation(async ([branch]) => new Map([[branch!, { descriptorUi: 'parent', label: 'Parent', treeNumber: branch! }]]));
  children.mockImplementation(async (branch) => [{ descriptorUi: 'child', label: 'Child', treeNumber: `${branch}.001` }]);
  const check = jest.fn();
  const result = await fetchMeshContext({ descriptor: 'term', treeNumber: '' }, eutils, check);
  expect(children).toHaveBeenCalledTimes(3);
  expect(tree).toHaveBeenCalledWith(['term'], { ...eutils, maxRetries: 1 });
  expect(result).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'parent', treeNumbers: ['A01', 'A02', 'A03'], childIds: ['child'], parentIds: [] }),
    expect.objectContaining({ id: 'child', parentIds: ['parent'], childIds: [] }),
  ]));
  expect(check).toHaveBeenCalledTimes(8);
});
test('明示枝では descriptor 解決を省略し、未取得の親を作らない', async () => {
  labels.mockResolvedValue(new Map());
  children.mockResolvedValue([{ descriptorUi: 'child', label: 'Child', treeNumber: 'A01.001' }]);
  const result = await fetchMeshContext({ descriptor: '', treeNumber: 'A01' }, eutils);
  expect(tree).not.toHaveBeenCalled();
  expect(result[0]!.parentIds).toEqual([]);
});
test('停止と通信例外を握りつぶさない', async () => {
  await expect(fetchMeshContext({ descriptor: '', treeNumber: 'A01' }, eutils, () => { throw new Error('stop'); })).rejects.toThrow('stop');
  expect(labels).not.toHaveBeenCalled();
  labels.mockRejectedValue(new Error('offline'));
  await expect(fetchMeshContext({ descriptor: '', treeNumber: 'A01' }, eutils)).rejects.toThrow('offline');
});
