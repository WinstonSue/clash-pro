import { createHash, randomBytes } from 'node:crypto';

export const LANES = ['agent', 'daily'];
export const OLD_ROUTES = { agent: ['A', 'B'], daily: ['B', 'A'] };
export const isSupplier = id => typeof id === 'string' && /^(?:[AB]|p[0-9a-f]{12})$/.test(id);
export const newSupplier = () => `p${randomBytes(6).toString('hex')}`;
export const providerName = id => `ClashPro-${id}`;

export function topology(state) {
  const plan = state.networkMode === 'client'
    ? { mode: 'client', pairing: state.pairing }
    : { mode: 'local', suppliers: Object.keys(state.suppliers).sort(), routes: state.routes };
  return `ClashPro-Config-${createHash('sha256').update(JSON.stringify(plan)).digest('hex').slice(0, 20)}`;
}
