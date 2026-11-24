import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse, stringify } from 'yaml';
import { PROBE_URL, SECONDARY_PROBE_URL, parseSubscription, groupFor, JUMP } from '../profiles.mjs';
import { createMonitor, checkRegion, monitorScopes } from '../monitor.mjs';
import { startApp } from '../server.mjs';
import { encodePairing } from '../gateway.mjs';
import { openStore } from '../state.mjs';
import { providerName } from '../suppliers.mjs';

const fixture = (region = '日本', suffix = 'one') => stringify({
  proxies: [{ name: `${region} 01`, type: 'ss', server: `${suffix}.example.test`, port: 443,
    cipher: 'aes-128-gcm', password: 'synthetic-secret', udp: true }],
  dns: { enable: false }, rules: ['MATCH,SupplierGroup'],
});

const offline = () => ({ state: 'offline', message: 'test' });

async function launch(t, options = {}, personalDirect) {
  const directory = await mkdtemp(join(tmpdir(), 'clash-pro-test-'));
  if (personalDirect) await writeFile(join(directory, 'personal-direct.json'), JSON.stringify(personalDirect));
  const app = await startApp({ directory, port: 0, background: false, validate: async () => {},
    clash: { view: async () => offline(), probe: async () => null }, ...options });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const api = (name, body) => fetch(new URL(`api/${name}`, app.url), body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { app, api, directory };
}

async function addSupplier(api, name) {
  const response = await api('suppliers', { action: 'create', name });
  assert.equal(response.status, 200);
  const { suppliers } = await response.json();
  return Object.keys(suppliers).find(id => suppliers[id].name === name);
}

test('imports temporary links explicitly, protects feeds, and preserves previous snapshots', async (t) => {
  const urls = [];
  const { api, directory } = await launch(t, { download: async (url) => {
    urls.push(url);
    if (url.endsWith('/expired')) throw new Error('供应商返回 HTTP 410。');
    return fixture('日本', url.endsWith('/new') ? 'new' : url.endsWith('/b') ? 'b' : 'a');
  } });
  const a = await addSupplier(api, '稳定');
  const bId = await addSupplier(api, '便宜');
  const initial = await (await api('state')).json();
  assert.equal(initial.region, 'JP');
  assert.deepEqual(initial.intervals, { active: 10, extra: 30 });
  const detailsURL = `suppliers/${a}/nodes`;
  assert.deepEqual(await (await api(detailsURL)).json(), { nodes: [] });
  assert.equal((await fetch(new URL(`/api/${detailsURL}`, initial.profileURL))).status, 404);
  const profile = parse(await (await fetch(initial.profileURL)).text());
  const { url, header } = profile['proxy-providers'][providerName(a)];
  assert.equal((await fetch(url)).status, 404);
  const readFeed = async () => parse(await (await fetch(url, { headers: { Authorization: header.Authorization[0] } })).text());
  assert.deepEqual((await readFeed()).proxies, []);
  assert.equal((await api('import', { supplier: a, url: 'https://supplier.example.test/a' })).status, 200);
  assert.equal((await api('import', { supplier: bId, url: 'https://supplier.example.test/b' })).status, 200);
  assert.equal((await api('import', { supplier: a, url: 'https://supplier.example.test/expired' })).status, 422);
  assert.equal((await readFeed()).proxies[0].server, 'a.example.test');
  assert.equal((await api('import', { supplier: a, url: 'https://supplier.example.test/new' })).status, 200);
  assert.equal((await readFeed()).proxies[0].server, 'new.example.test');
  assert.deepEqual(await (await api(detailsURL)).json(), { nodes: [{ name: '日本 01', region: 'JP', protocol: 'ss' }] });
  const b = profile['proxy-providers'][providerName(bId)];
  assert.equal(parse(await (await fetch(b.url, { headers: { Authorization: b.header.Authorization[0] } })).text())
    .proxies[0].server, 'b.example.test');
  assert.equal(urls.length, 4);
  assert.doesNotMatch(await readFile(join(directory, 'state.json'), 'utf8'), /supplier\.example\.test/);
  assert.doesNotMatch(JSON.stringify(await (await api('state')).json()), /synthetic-secret|a\.example\.test/);
});

test('generated profile applies ordered whitelist rules, regional preferences and private rule feeds', async (t) => {
  const personal = ['DOMAIN-SUFFIX,local-example.test,DIRECT', 'IP-CIDR,192.0.2.10/32,DIRECT'];
  const { api } = await launch(t, {}, personal);
  const a = await addSupplier(api, '稳定');
  const b = await addSupplier(api, '便宜');
  const c = await addSupplier(api, '备用');
  assert.equal((await api('routes', { agent: [a, c, b], daily: [b, c] })).status, 200);
  assert.equal((await api('routes', { agent: [a, a], daily: [] })).status, 400);
  const res = await api('settings', { region: 'SG', extraRegions: ['HK', 'HK'], intervals: { active: 15, extra: 45 } });
  assert.equal(res.status, 200);
  const state = await res.json();
  assert.deepEqual(state.extraRegions, ['HK']);
  const profile = parse(await (await fetch(state.profileURL)).text());
  const groups = profile['proxy-groups'];
  assert.deepEqual(groups.filter((group) => group.type === 'select' && !group.hidden).map((group) => group['default-selected']),
    [groupFor('agent', 'SG'), groupFor('daily', 'SG')]);
  assert.deepEqual(groups.find((group) => group.name === groupFor('agent', 'SG')).use, [a, c, b].map(providerName));
  assert.deepEqual(groups.find((group) => group.name === groupFor('daily', 'SG')).use, [b, c].map(providerName));
  const importantRules = [
    personal[0], `${personal[1]},no-resolve`, 'RULE-SET,clash-pro-domain-cn,DIRECT',
    'AND,((PROCESS-NAME,aria2c),(RULE-SET,clash-pro-ip-cn)),DIRECT',
    'PROCESS-NAME,aria2c,ClashPro-Daily', 'DOMAIN,gemini.google.com,ClashPro-Agent',
    'DOMAIN,registry.npmjs.org,DIRECT', 'RULE-SET,clash-pro-domain-github,ClashPro-Daily',
    'RULE-SET,clash-pro-ip-telegram,ClashPro-Daily,no-resolve',
    'RULE-SET,clash-pro-domain-gfw,ClashPro-Daily', 'RULE-SET,clash-pro-domain-gfw,REJECT',
  ];
  let previousIndex = -1;
  for (const rule of importantRules) {
    const index = profile.rules.indexOf(rule);
    assert.ok(index > previousIndex, `missing or misplaced rule: ${rule}`);
    previousIndex = index;
  }
  assert.equal(profile.rules.at(-1), 'MATCH,DIRECT');
  assert.doesNotMatch(JSON.stringify(state), /local-example/);
  const google = profile['rule-providers']['clash-pro-domain-google'];
  assert.equal((await fetch(google.url)).status, 404);
  const headers = { Authorization: google.header.Authorization[0] };
  const response = await fetch(google.url, { headers });
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),
    await readFile(new URL('../rules-data/domain-google.mrs', import.meta.url)));
  assert.equal((await fetch(new URL('unknown.mrs', google.url), { headers })).status, 404);
});

test('routing region and heartbeat settings save independently', async (t) => {
  const switches = [];
  const clash = {
    view: async () => ({ state: 'managed' }),
    selectRegion: async (region) => {
      if (region === 'TW') throw new Error('模拟地区切换失败。');
      switches.push(region);
    },
  };
  const { api } = await launch(t, { clash });
  const supplier = await addSupplier(api, '主线');
  const routes = { agent: [supplier], daily: [supplier] };
  assert.equal((await api('routes', routes)).status, 200);
  const intervals = { active: 15, extra: 45 };
  const initial = await (await api('settings', { extraRegions: ['SG', 'HK'], intervals })).json();
  assert.equal(initial.region, 'JP');
  assert.deepEqual(initial.routes, routes);
  assert.deepEqual(switches, []);

  const regionOnly = await (await api('settings', { region: 'SG' })).json();
  assert.deepEqual(regionOnly.extraRegions, ['HK']);
  assert.deepEqual(regionOnly.intervals, intervals);
  assert.deepEqual(switches, ['SG']);
  const profile = parse(await (await fetch(regionOnly.profileURL)).text());
  assert.deepEqual(profile['proxy-groups'].filter(group => group['default-selected'])
    .map(group => group['default-selected']), [groupFor('agent', 'SG'), groupFor('daily', 'SG')]);

  const heartbeat = { extraRegions: ['US', 'HK', 'JP', 'US'], intervals: { active: 20, extra: 50 } };
  const writes = await Promise.all([api('settings', { region: 'JP' }), api('settings', heartbeat)]);
  assert.deepEqual(writes.map(response => response.status), [200, 200]);
  const saved = await (await api('state')).json();
  assert.equal(saved.region, 'JP');
  assert.deepEqual(saved.extraRegions, ['US', 'HK']);
  assert.deepEqual(saved.intervals, heartbeat.intervals);
  assert.deepEqual(saved.routes, routes);
  assert.deepEqual(switches, ['SG', 'JP']);

  assert.equal((await api('settings', { intervals })).status, 400);
  assert.equal((await api('settings', { extraRegions: [], intervals: { active: 0, extra: 30 } })).status, 400);
  assert.equal((await api('settings', { region: 'TW' })).status, 502);
  assert.equal((await (await api('state')).json()).region, saved.region);
});

const node = (name, endpoint, region = 'JP') => ({ region, endpoint, proxy: { name } });

test('monitor deduplicates endpoints while confirming failures at an independent site', async () => {
  const scope = { supplier: 'A', nodes: [node('first', 'a:443'), node('duplicate', 'a:443'), node('second', 'b:443')] };
  const one = await checkRegion(scope, async (_, name, url) => name === 'duplicate' && url === PROBE_URL);
  assert.deepEqual(one, { status: 'warning', available: 1, total: 2 });
  const rescued = await checkRegion(scope, async (_, name, url) => name === 'first' || url === SECONDARY_PROBE_URL);
  assert.deepEqual(rescued, { status: 'healthy', available: 2, total: 2 });
  const missing = await checkRegion(scope, async () => null);
  assert.equal(missing.status, 'unknown');
});

test('monitor covers just selected regions, warns twice-confirmed low capacity and escalates total failure', async () => {
  const a = [...parseSubscription(fixture(), 'A').nodes, node('other', 'hk:443', 'HK'), node('unused', 'us:443', 'US')];
  let state = { region: 'JP', extraRegions: ['HK'], intervals: { active: 1, extra: 1 },
    suppliers: { A: { id: 'one', nodes: a }, B: null }, incidents: {}, alerts: [] };
  const store = { get: () => state, async change(update) { state = update(state); } };
  assert.deepEqual(monitorScopes(state).map(({ key }) => key), ['A:JP', 'B:JP', 'A:HK', 'B:HK']);
  let time = 100_000;
  let available = true;
  const alerts = [];
  const monitor = createMonitor({ store, controller: () => true, probe: async () => available,
    now: () => time, emit: (event) => alerts.push(event) });
  async function minute() {
    for (let i = 0; i < 4; i += 1) { time += 15_000; await monitor.tick(); }
  }
  await monitor.tick();
  assert.equal(alerts.length, 0);
  await minute();
  assert.deepEqual(alerts.map(({ supplier, region, level }) => [supplier, region, level]),
    [['A', 'JP', 'warning'], ['A', 'HK', 'warning']]);
  available = false;
  await minute();
  assert.equal(alerts.length, 2);
  await minute();
  assert.deepEqual(alerts.slice(2).map(({ level }) => level), ['down', 'down']);
  await minute();
  assert.equal(alerts.length, 4);
});

test('version 1 migration preserves tokens, node batches, alerts and rollback copy', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'clash-pro-migrate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const legacy = { version: 1, token: 'v'.repeat(43), region: 'JP', intervals: { active: 10, extra: 30 },
    extraRegions: ['HK'], suppliers: { A: { id: 'first', nodes: parseSubscription(fixture(), 'A').nodes }, B: null },
    incidents: { 'A:JP': { revision: 'first', level: 'warning' } }, alerts: [{ id: 'test', supplier: 'A' }] };
  const original = JSON.stringify(legacy);
  await writeFile(join(dir, 'state.json'), original, { mode: 0o600 });
  const migrated = (await openStore(dir)).get();
  assert.equal(migrated.version, 2);
  for (const key of ['token', 'suppliers', 'incidents', 'alerts', 'extraRegions']) assert.deepEqual(migrated[key], legacy[key]);
  assert.deepEqual(migrated.routes, { agent: ['A', 'B'], daily: ['B', 'A'] });
  assert.equal(await readFile(join(dir, 'state-v1.backup.json'), 'utf8'), original);
  assert.deepEqual((await openStore(dir)).get(), migrated);
});

test('pairing is bound to the target and the generated client has a single hop', async (t) => {
  const key = Buffer.alloc(16, 2).toString('base64');
  const host = '100.64.0.10';
  const target = '100.64.0.20';
  const discover = async () => ({ address: target, peers: [{ id: 'test', address: host }] });
  const gateway = {
    scan: discover, snapshot: () => ({ state: 'off' }), async sync() {}, async close() {},
  };
  let verifies = 0;
  const { api } = await launch(t, { gateway, verify: async pairing => {
    verifies++;
    assert.equal(pairing.key, key);
  } });
  const wrong = encodePairing(host, { address: '100.64.0.21', key });
  assert.equal((await api('pairing', { action: 'connect', code: wrong })).status, 422);
  const code = encodePairing(host, { address: target, key });
  const response = await api('pairing', { action: 'connect', code });
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.equal(state.networkMode, 'client');
  assert.equal(verifies, 1);
  assert.doesNotMatch(JSON.stringify(state), /AgICAg/);
  const profile = parse(await (await fetch(state.profileURL)).text());
  assert.equal(profile.proxies[0].name, JUMP);
  assert.equal(profile.proxies[0].password, key);
  assert.equal(profile.proxies[0].udp, true);
  assert.ok(profile.rules.includes('RULE-SET,clash-pro-domain-youtube,ClashPro-Jump'));
  assert.ok(profile.rules.includes('RULE-SET,clash-pro-domain-cn,DIRECT'));
  assert.equal(profile['proxy-providers'], undefined);
  assert.equal(profile.rules.at(-1), 'MATCH,DIRECT');
});

test('a saved priority edit or supplier removal preserves the active configuration until refresh', async (t) => {
  let applied;
  let activeRoutes = { agent: [], daily: [] };
  const clash = {
    view: async () => ({ state: 'managed', agent: { now: groupFor('agent', 'JP') },
      daily: { now: groupFor('daily', 'JP') } }),
    hasTopology: async marker => marker === applied,
    activeRoutes: async () => activeRoutes,
    hasProvider: async () => true,
    updateProvider: async () => {},
    probe: async () => null,
  };
  const { api, app } = await launch(t, { clash, download: async () => fixture() });
  const a = await addSupplier(api, '稳定');
  const b = await addSupplier(api, '便宜');
  async function configMarker() {
    const { profileURL } = await (await api('state')).json();
    return parse(await (await fetch(profileURL)).text())['proxy-groups'].find(group => group.name.startsWith('ClashPro-Config-')).name;
  }
  applied = await configMarker();
  await app.syncClash();
  const rename = await (await api('suppliers', { action: 'rename', id: a, name: '主线' })).json();
  assert.equal(rename.controller.needsRefresh, false);
  assert.equal(await configMarker(), applied);
  const edited = await (await api('routes', { agent: [a, b], daily: [b] })).json();
  assert.equal(edited.controller.needsRefresh, true);
  assert.deepEqual(edited.controller.activeRoutes, { agent: [], daily: [] });
  applied = await configMarker();
  await app.syncClash();
  const active = await (await api('state')).json();
  assert.equal(active.controller.needsRefresh, false);
  assert.deepEqual(active.controller.activeRoutes, { agent: [a, b], daily: [b] });

  activeRoutes = active.controller.activeRoutes;
  assert.equal((await api('import', { supplier: b, url: 'https://supplier.example.test/b' })).status, 200);
  const oldProfile = parse(await (await fetch(active.profileURL)).text());
  const feed = oldProfile['proxy-providers'][providerName(b)];
  const readOldFeed = () => fetch(feed.url, { headers: { Authorization: feed.header.Authorization[0] } });
  const removed = await (await api('suppliers', { action: 'remove', id: b })).json();
  assert.equal(Object.hasOwn(removed.suppliers, b), false);
  assert.ok(removed.health.every(row => row.supplier !== b));
  assert.deepEqual(removed.routes, { agent: [a], daily: [] });
  assert.equal(removed.controller.needsRefresh, true);
  assert.deepEqual(removed.controller.activeRoutes, activeRoutes);
  assert.equal(parse(await (await readOldFeed()).text()).proxies.length, 1);
  const nextProfile = parse(await (await fetch(removed.profileURL)).text());
  assert.deepEqual(nextProfile['proxy-groups'].find(group => group.name === groupFor('daily', 'JP')).proxies, ['REJECT']);
  applied = await configMarker();
  await app.syncClash();
  const afterRefresh = await (await api('state')).json();
  assert.equal(afterRefresh.controller.needsRefresh, false);
  assert.deepEqual(afterRefresh.controller.activeRoutes, removed.routes);
  assert.equal((await readOldFeed()).status, 404);
});

test('relay accepts both transports and closes authorized sessions on revocation', async (t) => {
  const { createServer, createConnection } = await import('node:net');
  const { createSocket } = await import('node:dgram');
  const { once } = await import('node:events');
  const { openRelay } = await import('../gateway.mjs');
  const echo = createServer(socket => socket.pipe(socket));
  echo.listen(0, '127.0.0.1');
  await once(echo, 'listening');
  const backend = echo.address().port;
  const echoUDP = createSocket('udp4');
  echoUDP.on('message', (bytes, sender) => echoUDP.send(bytes, sender.port, sender.address));
  echoUDP.bind(backend, '127.0.0.1');
  await once(echoUDP, 'listening');
  const relay = await openRelay('127.0.0.1', 0);
  const tcp = createConnection(relay.port, '127.0.0.1');
  const udp = createSocket('udp4');
  t.after(async () => {
    tcp.destroy();
    try { udp.close(); } catch {}
    await relay.close();
    echo.close();
    echoUDP.close();
  });
  relay.configure([{ id: 'test', address: '127.0.0.1', backend }]);
  await once(tcp, 'connect');
  tcp.write('tcp');
  assert.equal((await once(tcp, 'data'))[0].toString(), 'tcp');
  udp.send('udp', relay.port, '127.0.0.1');
  assert.equal((await once(udp, 'message'))[0].toString(), 'udp');
  const disconnected = once(tcp, 'close');
  relay.configure([]);
  await disconnected;
  udp.send('revoked', relay.port, '127.0.0.1');
  await assert.rejects(once(udp, 'message', { signal: AbortSignal.timeout(180) }), { name: 'AbortError' });
});
