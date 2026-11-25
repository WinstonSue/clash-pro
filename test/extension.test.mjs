import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { parse, stringify } from 'yaml';
import { openAllowlist, projectAllowlistURL } from '../allowlist.mjs';
import { createClash } from '../clash.mjs';
import { PROBE_URL, SECONDARY_PROBE_URL, parseSubscription, buildGatewayProfile, groupFor, JUMP } from '../profiles.mjs';
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
const agentAllowlist = 'RULE-SET,clash-pro-allowlist-agent';
const dailyAllowlist = 'RULE-SET,clash-pro-allowlist-daily';

const agentServiceMatches = [
  'DOMAIN-SUFFIX,aireiter.com',
  'DOMAIN-SUFFIX,antigravity.google',
  'DOMAIN,antigravity.googleapis.com',
  'DOMAIN,antigravity-pa.googleapis.com',
  'DOMAIN,agentaicode.googleapis.com',
  'DOMAIN,aicode.googleapis.com',
  'DOMAIN,antigravity-cli-auto-updater-974169037036.us-central1.run.app',
];

function assertProxyRule(rules, match, target, before) {
  const rule = `${match},${target}`;
  const index = rules.indexOf(rule);
  assert.ok(index >= 0 && index < rules.indexOf(before), `missing or misplaced rule: ${rule}`);
  assert.equal(rules[index + 1], `${match},REJECT`);
}

const readRuleProvider = ({ url, header }) => fetch(url, { headers: { Authorization: header.Authorization[0] } });

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
  const routing = await (await api('routing')).json();
  assert.deepEqual(routing.rules, profile.rules);
  assert.equal(routing.networkMode, 'local');
  const groups = profile['proxy-groups'];
  assert.deepEqual(groups.filter((group) => group.type === 'select' && !group.hidden).map((group) => group['default-selected']),
    [groupFor('agent', 'SG'), groupFor('daily', 'SG')]);
  assert.deepEqual(groups.find((group) => group.name === groupFor('agent', 'SG')).use, [a, c, b].map(providerName));
  assert.deepEqual(groups.find((group) => group.name === groupFor('daily', 'SG')).use, [b, c].map(providerName));
  const importantRules = [
    personal[0], `${personal[1]},no-resolve`, 'RULE-SET,clash-pro-domain-cn,DIRECT',
    'AND,((PROCESS-NAME,aria2c),(RULE-SET,clash-pro-ip-cn)),DIRECT',
    'PROCESS-NAME,aria2c,ClashPro-Daily', `${agentAllowlist},ClashPro-Agent`,
    'AND,((PROCESS-NAME,codex),(RULE-SET,clash-pro-ip-cn,no-resolve)),DIRECT',
    'PROCESS-NAME,codex,ClashPro-Agent', 'DOMAIN,registry.npmjs.org,DIRECT',
    `${dailyAllowlist},ClashPro-Daily`, `${dailyAllowlist},REJECT`,
    'RULE-SET,clash-pro-ip-cn,DIRECT,no-resolve',
  ];
  let previousIndex = -1;
  for (const rule of importantRules) {
    const index = profile.rules.indexOf(rule);
    assert.ok(index > previousIndex, `missing or misplaced rule: ${rule}`);
    previousIndex = index;
  }
  assertProxyRule(profile.rules, agentAllowlist, 'ClashPro-Agent', `${dailyAllowlist},ClashPro-Daily`);
  const agentProvider = profile['rule-providers']['clash-pro-allowlist-agent'];
  assert.equal(agentProvider.interval, 5);
  assert.equal(agentProvider.proxy, 'DIRECT');
  assert.equal((await fetch(agentProvider.url)).status, 404);
  const agentRules = (await (await readRuleProvider(agentProvider)).text()).trim().split('\n');
  for (const match of agentServiceMatches) assert.ok(agentRules.includes(match));
  for (const host of ['accounts.google.com', 'oauth2.googleapis.com', 'storage.googleapis.com']) {
    assert.ok(!agentRules.includes(`DOMAIN,${host}`));
  }
  const dailyRules = (await (await readRuleProvider(profile['rule-providers']['clash-pro-allowlist-daily'])).text()).trim().split('\n');
  const lastDailyRules = ['AND,((RULE-SET,clash-pro-ip-telegram,no-resolve))', 'AND,((RULE-SET,clash-pro-domain-gfw))'];
  assert.ok(dailyRules.includes('AND,((RULE-SET,clash-pro-domain-google))'));
  assert.deepEqual(dailyRules.slice(-2), lastDailyRules);
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

test('bundled rule entries are browsable and searchable through the private routing API', async (t) => {
  const { app, api } = await launch(t);
  const { revision, ruleSets, allowlist } = await (await api('routing')).json();
  assert.match(revision, /^[\da-f]{40}$/);
  assert.equal(ruleSets.length, 25);
  assert.ok(allowlist.daily.includes('RULE-SET,domain-gfw'));
  const entries = async query => (await api(`routing/entries?${new URLSearchParams(query)}`)).json();
  const raw = (await readFile(new URL('../rules-source/domain-cn.list', import.meta.url), 'utf8')).trimEnd().split('\n');
  assert.equal(ruleSets.find(({ name }) => name === 'domain-cn').count, raw.length);
  for (const number of [1, 2, Math.ceil(raw.length / 100)]) {
    const result = await entries({ set: 'domain-cn', page: number });
    assert.equal(result.total, raw.length);
    assert.equal(result.pageSize, 100);
    assert.deepEqual(result.entries.map(({ rule }) => rule), raw.slice((number - 1) * 100, number * 100));
  }
  assert.ok((await entries({ set: 'ip-telegram' })).entries.every(({ rule }) => rule.includes('/')));
  const google = await entries({ q: 'WWW.GOOGLE.COM.' });
  assert.ok(google.entries.some(({ ruleSet, rule }) => ruleSet === 'domain-google' && rule === '+.google.com'));
  const github = await entries({ q: 'github.com' });
  assert.ok(github.entries.some(({ ruleSet }) => ruleSet === 'domain-github'));
  assert.ok(github.entries.some(({ ruleSet }) => ruleSet === 'domain-gfw'));
  assert.equal((await entries({ q: 'challenges.cloudflare.com' })).total, 0);
  assert.equal((await api('routing/entries?set=unknown')).status, 404);
  assert.equal((await api('routing/entries?page=0')).status, 400);
  for (const path of ['/api/routing', '/api/routing/entries']) {
    assert.equal((await fetch(new URL(path, app.url))).status, 404);
  }
});

test('routing overview reports which allowlists the running Clash Verge profile has loaded', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'cp-core-'));
  const socket = join(directory, 'ctl.sock');
  let rules = [{ type: 'RuleSet', payload: 'clash-pro-domain-gfw', proxy: 'ClashPro-Daily' }];
  const providers = {};
  const server = createServer((req, res) => res.end(JSON.stringify(req.url === '/rules' ? { rules } : { providers })));
  await new Promise((resolve, reject) => server.once('error', reject).listen(socket, resolve));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { api } = await launch(t, { clash: createClash(socket) });
  const status = async () => (await (await api('routing')).json()).status;
  try {
    assert.equal(await status(), 'unreferenced');
    rules = ['agent', 'daily'].map(lane => ({ type: 'RuleSet', payload: `clash-pro-allowlist-${lane}`, proxy: 'route' }));
    providers['clash-pro-allowlist-agent'] = { ruleCount: 0, updatedAt: '0001-01-01T00:00:00Z' };
    providers['clash-pro-allowlist-daily'] = { ruleCount: 1, updatedAt: '2026-11-25T00:00:00Z' };
    assert.equal(await status(), 'loading');
    providers['clash-pro-allowlist-agent'].updatedAt = '2026-11-25T00:00:00Z';
    assert.equal(await status(), 'loaded');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  assert.equal(await status(), 'offline');
});

test('allowlist saves, previews remote replacements, and detects concurrent updates', async (t) => {
  const remote = { agent: ['RULE-SET,domain-github'], daily: [] };
  const project = { agent: [], daily: ['DOMAIN-SUFFIX,project.example.test'] };
  let projectOffline = false;
  const downloaded = [];
  const { api, directory, app } = await launch(t, { downloadAllowlist: async url => {
    downloaded.push(url);
    if (url === projectAllowlistURL) {
      if (projectOffline) throw new Error('供应商返回 HTTP 404。请获取新的链接。');
      return JSON.stringify(project);
    }
    if (url.endsWith('/offline')) throw new Error('remote test failure');
    return url.endsWith('/invalid') ? '{"agent":[]}' : JSON.stringify(remote);
  } });
  const current = async () => (await api('allowlist')).json();
  const save = (revision, rules) => api('allowlist', { action: 'save', revision, rules });
  const state = await (await api('state')).json();
  const profile = parse(await (await fetch(state.profileURL)).text());
  const initial = await current();
  assert.equal(initial.error, null);
  assert.equal(initial.projectURL, projectAllowlistURL);
  assert.deepEqual(JSON.parse(await readFile(initial.file, 'utf8')), initial.rules);
  assert.equal((await fetch(new URL('/api/allowlist', app.url))).status, 404);
  assert.equal((await fetch(new URL('api/allowlist', app.url),
    { method: 'POST', headers: { Origin: 'https://example.test' } })).status, 403);
  for (const rule of ['RULE-SET,domain-cn', 'RULE-SET,ip-telegram', 'DOMAIN,example.test,DIRECT']) {
    assert.equal((await save(initial.revision, { agent: [rule], daily: [] })).status, 422);
  }
  const manual = { agent: ['DOMAIN,MANUAL.example.test', 'DOMAIN,manual.example.test'], daily: [] };
  const written = await save(initial.revision, manual);
  assert.equal(written.status, 200);
  const saved = await written.json();
  assert.deepEqual(saved.rules, { agent: ['DOMAIN,manual.example.test'], daily: [] });
  assert.equal(await (await readRuleProvider(profile['rule-providers']['clash-pro-allowlist-agent'])).text(),
    'DOMAIN,manual.example.test\n');
  assert.equal(await (await readRuleProvider(profile['rule-providers']['clash-pro-allowlist-daily'])).text(),
    '# Empty allowlist\n');

  const source = 'https://rules.example.test/allowlist';
  assert.equal((await api('allowlist', { action: 'source', url: 'https://127.0.0.1/rules' })).status, 400);
  assert.equal((await api('allowlist', { action: 'source', url: source })).status, 200);
  assert.equal((await current()).sourceURL, source);
  const preview = async url => api('allowlist', { action: 'preview', url });
  assert.equal((await preview('https://rules.example.test/offline')).status, 502);
  assert.equal((await preview('https://rules.example.test/invalid')).status, 422);
  const first = await (await preview(source)).json();
  assert.deepEqual(first.rules, remote);
  assert.deepEqual(first.changes.agent, { added: remote.agent, removed: saved.rules.agent, reordered: false });
  assert.deepEqual((await current()).rules, saved.rules);
  const previewProject = () => api('allowlist', { action: 'preview', source: 'project', url: source });
  projectOffline = true;
  const unavailable = await previewProject();
  assert.equal(unavailable.status, 502);
  assert.match((await unavailable.json()).error, /项目白名单.*HTTP 404/);
  projectOffline = false;
  const projectPreview = await (await previewProject()).json();
  assert.equal(downloaded.at(-1), projectAllowlistURL);
  assert.deepEqual(projectPreview.rules, project);
  assert.equal((await current()).sourceURL, source);
  assert.deepEqual((await current()).rules, saved.rules);

  const file = join(directory, 'proxy-allowlist.json');
  const external = { agent: ['DOMAIN-SUFFIX,external.example.test'], daily: ['RULE-SET,ip-telegram'] };
  await writeFile(file, JSON.stringify(external));
  assert.equal((await save(first.revision, first.rules)).status, 409);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), external);
  const latest = await (await preview(source)).json();
  const results = await Promise.all([save(latest.revision, latest.rules), save(latest.revision, saved.rules)]);
  assert.deepEqual(results.map(response => response.status).sort(), [200, 409]);
  const winning = await results.find(response => response.ok).json();
  assert.deepEqual((await current()).rules, winning.rules);
  if (winning.rules.agent[0] !== remote.agent[0]) {
    assert.equal((await save(winning.revision, latest.rules)).status, 200);
  }
  assert.equal(await (await readRuleProvider(profile['rule-providers']['clash-pro-allowlist-agent'])).text(),
    'AND,((RULE-SET,clash-pro-domain-github))\n');
  const freshProject = await (await previewProject()).json();
  assert.equal((await save(freshProject.revision, freshProject.rules)).status, 200);
  assert.deepEqual((await current()).rules, project);
  assert.equal((await current()).sourceURL, source);
});

test('external edits are polled and a malformed file retains the last good rules after restart', { timeout: 12_000 }, async (t) => {
  const { api, directory } = await launch(t, { background: true });
  const { profileURL } = await (await api('state')).json();
  const profile = parse(await (await fetch(profileURL)).text());
  const provider = profile['rule-providers']['clash-pro-allowlist-agent'];
  const file = join(directory, 'proxy-allowlist.json');
  const rules = { agent: ['DOMAIN,polled.example.test'], daily: [] };
  await writeFile(file, JSON.stringify(rules));
  const deadline = Date.now() + 8_000;
  let feed;
  do {
    feed = await (await readRuleProvider(provider)).text();
    if (feed === 'DOMAIN,polled.example.test\n') break;
    await delay(100);
  } while (Date.now() < deadline);
  assert.equal(feed, 'DOMAIN,polled.example.test\n');

  await writeFile(file, '{');
  const invalid = await (await api('allowlist')).json();
  assert.match(invalid.error, /JSON/);
  assert.deepEqual(invalid.rules, rules);
  assert.equal(await (await readRuleProvider(provider)).text(), feed);
  const restarted = await openAllowlist(directory);
  assert.deepEqual((await restarted.read()).rules, rules);
  await rm(file);
  assert.match((await restarted.read()).error, /未找到/);
  assert.equal(restarted.feed('agent'), feed);
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
  const routing = await (await api('routing')).json();
  assert.deepEqual(routing.rules, profile.rules);
  assert.equal(routing.networkMode, 'client');
  assert.equal(profile.proxies[0].password, key);
  assert.equal(profile.proxies[0].udp, true);
  assert.ok(profile.rules.includes(`${dailyAllowlist},${JUMP}`));
  assert.ok(profile.rules.includes('RULE-SET,clash-pro-domain-cn,DIRECT'));
  assertProxyRule(profile.rules, agentAllowlist, JUMP, `${dailyAllowlist},${JUMP}`);
  assert.equal(profile['proxy-providers'], undefined);
  assert.equal(profile.rules.at(-1), 'MATCH,DIRECT');
});

test('gateway uses the Agent TCP and UDP groups for the same editable Agent allowlist', () => {
  const region = 'JP';
  const state = { token: 'test-token', region, intervals: { active: 10 }, extraRegions: [],
    routes: { agent: [], daily: [] }, suppliers: {} };
  const profile = buildGatewayProfile({ port: 17880, state, peers: [] });
  const agent = groupFor('agent', region);
  const daily = groupFor('daily', region);
  assertProxyRule(profile.rules, `AND,((NETWORK,udp),(${agentAllowlist}))`, `${agent}-UDP`, `${agentAllowlist},${agent}`);
  assertProxyRule(profile.rules, agentAllowlist, agent, `NETWORK,tcp,${daily}`);
  assert.equal(profile['rule-providers']['clash-pro-allowlist-agent'].interval, 5);
  assert.equal(profile['rule-providers']['clash-pro-allowlist-daily'], undefined);
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
