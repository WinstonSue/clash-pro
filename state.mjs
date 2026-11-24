import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OLD_ROUTES } from './suppliers.mjs';

const freshState = () => ({
  version: 2,
  token: randomBytes(32).toString('base64url'),
  region: 'JP',
  extraRegions: [],
  intervals: { active: 10, extra: 30 },
  suppliers: {},
  retired: {},
  names: {},
  routes: { agent: [], daily: [] },
  networkMode: 'local', pairing: null, sharing: { enabled: false, peers: [] },
  incidents: {},
  alerts: [],
});

export async function openStore(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, 'state.json');
  let value;
  let original;
  try {
    original = await readFile(file, 'utf8');
    value = JSON.parse(original);
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('无法读取本机数据。');
    value = freshState();
    await save(value);
  }
  if (![1, 2].includes(value?.version) || !/^[A-Za-z0-9_-]{43}$/.test(value.token)) {
    throw new Error('本机数据版本不受支持。');
  }
  if (value.version === 1) {
    const backup = join(directory, 'state-v1.backup.json');
    try { await writeFile(backup, original, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    value = { ...freshState(), ...value, version: 2, names: { A: '供应商 1', B: '供应商 2' }, routes: OLD_ROUTES };
    await save(value);
  }

  async function save(next) {
    const pending = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(pending, JSON.stringify(next), { flag: 'wx', mode: 0o600 });
      await rename(pending, file);
    } finally {
      await rm(pending, { force: true });
    }
  }

  let queue = Promise.resolve();
  return {
    get: () => value,
    change(update) {
      const work = queue.then(async () => {
        const next = await update(value);
        if (next !== value) await save(next);
        value = next;
        return value;
      });
      queue = work.catch(() => {});
      return work;
    },
  };
}
