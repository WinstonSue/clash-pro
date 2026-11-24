import { randomUUID } from 'node:crypto';
import { REGIONS, PROBE_URL, SECONDARY_PROBE_URL } from './profiles.mjs';

const minute = 60_000;

export function monitorScopes(state) {
  const regions = new Set([state.region, ...state.extraRegions]);
  const scopes = [];
  for (const region of regions) {
    for (const supplier of Object.keys(state.suppliers)) {
      const revision = state.suppliers[supplier];
      const nodes = (revision?.nodes ?? []).filter((node) => node.region === region);
      scopes.push({
        key: `${supplier}:${region}`,
        supplier,
        region,
        revision: revision?.id,
        nodes,
        interval: (region === state.region ? state.intervals.active : state.intervals.extra) * minute,
      });
    }
  }
  return scopes;
}

function countEndpoints(nodes) {
  const endpoints = new Map();
  for (const node of nodes) {
    const candidates = endpoints.get(node.endpoint) ?? [];
    candidates.push(node.proxy.name);
    endpoints.set(node.endpoint, candidates);
  }
  return [...endpoints.values()];
}

async function parallel(items, limit, work) {
  let position = 0;
  const results = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (position < items.length) {
      const index = position++;
      results[index] = await work(items[index]);
    }
  }));
  return results;
}

export async function checkRegion(scope, probe) {
  const endpoints = countEndpoints(scope.nodes);
  if (!endpoints.length) return { status: 'empty', available: null, total: 0 };

  async function checkEndpoint(names, url) {
    let uncertain = false;
    for (const name of names) {
      let result;
      try { result = await probe(scope.supplier, name, url); } catch { result = null; }
      if (result === true) return true;
      if (result !== false) uncertain = true;
    }
    return uncertain ? null : false;
  }

  const primary = await parallel(endpoints, 6, (names) => checkEndpoint(names, PROBE_URL));
  let available = primary.filter((result) => result === true).length;
  let unknown = primary.includes(null);
  if (available <= 1) {
    const toVerify = endpoints.filter((_, index) => primary[index] !== true);
    const primaryFailures = primary.filter((value) => value !== true);
    const secondary = await parallel(toVerify, 6, (names) => checkEndpoint(names, SECONDARY_PROBE_URL));
    available += secondary.filter((result) => result === true).length;
    // A secondary success resolves an inconclusive primary; a missing sample
    // cannot establish that an endpoint failed both checks.
    unknown = secondary.some((result, index) => {
      return result === null || (primaryFailures[index] === null && result !== true);
    });
  }
  const total = endpoints.length;
  if (available <= 1 && unknown) return { status: 'unknown', available, total };
  return { status: available >= 2 ? 'healthy' : available === 1 ? 'warning' : 'down', available, total };
}

export function nextIncident(previous, status, sentLevel = null) {
  const count = previous?.status === status ? previous.count + 1 : 1;
  let level = sentLevel;
  if (count >= 2 && status === 'healthy') level = null;
  if (count >= 2 && status === 'warning' && level === null) level = 'warning';
  if (count >= 2 && status === 'down') level = 'down';
  return { status, count, level, shouldNotify: level !== null && level !== sentLevel };
}

export function createMonitor({ store, controller, network = () => true, probe, emit, now = Date.now }) {
  const observations = new Map();
  let previousTick;
  let running = false;
  let continuity = 0;
  let reachable = false;

  const same = (entry, scope) => entry && entry.revision === scope.revision && entry.interval === scope.interval;

  function observeScopes() {
    const scopes = monitorScopes(store.get());
    for (const scope of scopes) {
      if (same(observations.get(scope.key), scope)) continue;
      observations.set(scope.key, {
        ...scope, checkedAt: null, status: scope.nodes.length ? 'waiting' : 'empty',
        available: null, total: countEndpoints(scope.nodes).length, due: 0, streak: null,
      });
    }
    const expected = new Set(scopes.map(({ key }) => key));
    for (const key of observations.keys()) if (!expected.has(key)) observations.delete(key);
    return scopes;
  }

  async function tick() {
    const time = now();
    const gap = previousTick !== undefined && time - previousTick > 30_000;
    previousTick = time;
    const scopes = observeScopes();
    const currentLink = controller() && network();
    if (gap || reachable !== currentLink) continuity += 1;
    reachable = currentLink;
    if (gap || !reachable) {
      for (const entry of observations.values()) {
        if (!entry.total) continue;
        entry.status = 'unknown';
        entry.streak = null;
        entry.due = 0;
      }
    }
    if (running || !reachable) return;
    running = true;
    const round = continuity;
    try {
      for (const scope of scopes) {
        const entry = observations.get(scope.key);
        if (!reachable || continuity !== round || !entry?.total || entry.due > now()) continue;
        entry.status = 'checking';
        const result = await checkRegion(scope, probe);
        const current = monitorScopes(store.get()).find(({ key }) => key === scope.key);
        if (!current || !same(entry, current) || entry !== observations.get(scope.key) || round !== continuity) continue;
        const checked = now();
        Object.assign(entry, result, {
          checkedAt: new Date(checked).toISOString(),
          due: checked + scope.interval,
        });
        if (!controller() || !network() || result.status === 'unknown') {
          entry.streak = null;
          continue;
        }
        let notification;
        await store.change((state) => {
          const latest = monitorScopes(state).find(({ key }) => key === scope.key);
          if (!latest || !same(entry, latest)) return state;
          const last = state.incidents[scope.key];
          const sentLevel = last?.revision === scope.revision ? last.level : null;
          const streak = nextIncident(entry.streak, result.status, sentLevel);
          entry.streak = streak;
          if (streak.level === sentLevel) return state;
          const incidents = { ...state.incidents };
          if (streak.level) incidents[scope.key] = { revision: scope.revision, level: streak.level };
          else delete incidents[scope.key];
          if (!streak.shouldNotify) return { ...state, incidents };
          const supplierName = state.names?.[scope.supplier] ?? scope.supplier;
          const subject = `${supplierName} ${REGIONS[scope.region]}`;
          notification = {
            id: randomUUID(), supplier: scope.supplier, supplierName, region: scope.region, level: streak.level,
            message: streak.level === 'down' ? `${subject} 地区全断` : `${subject} 只剩 1 个可用端点`,
            time: entry.checkedAt,
          };
          return { ...state, incidents, alerts: [notification, ...state.alerts].slice(0, 40) };
        });
        if (notification) emit(notification);
      }
    } finally {
      running = false;
    }
  }

  return {
    tick,
    snapshot() {
      observeScopes();
      return [...observations.values()].map(({ supplier, region, available, total, status, checkedAt }) => ({
        supplier, region, available, total, status, checkedAt,
      }));
    },
  };
}
