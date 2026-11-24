import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir, networkInterfaces } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClash, dailyGroupFor, validateNodes } from './clash.mjs';
import { createMonitor } from './monitor.mjs';
import { createGateway, decodePairing, encodePairing, newPeer, verifyPairing } from './gateway.mjs';
import { buildProfile, encodeProvider, groupFor, parseSubscription, REGIONS, supplierNodeDetails } from './profiles.mjs';
import { readPersonalDirect, readRuleAsset } from './routing.mjs';
import { openStore } from './state.mjs';
import { fetchSubscription } from './subscription.mjs';
import { isSupplier, LANES, newSupplier, topology } from './suppliers.mjs';

const assets = {
  '': ['index.html', 'text/html; charset=utf-8'],
  'index.html': ['index.html', 'text/html; charset=utf-8'],
  'app.js': ['app.js', 'text/javascript; charset=utf-8'],
  'style.css': ['style.css', 'text/css; charset=utf-8'],
};
const securityHeaders = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function matchToken(value, token) {
  if (typeof value !== 'string') return false;
  const supplied = Buffer.from(value);
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function respond(res, status, type, body) {
  res.writeHead(status, { ...securityHeaders, 'Content-Type': type });
  res.end(body);
}

function json(res, status, body) {
  return respond(res, status, 'application/json; charset=utf-8', JSON.stringify(body));
}

async function readBody(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') {
    throw new ApiError(415, '请求格式不受支持。');
  }
  const parts = [];
  let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > 8_192) throw new ApiError(413, '请求过大。');
    parts.push(part);
  }
  try {
    const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw new ApiError(400, '请求格式不正确。'); }
}

function supplierSummary(batch) {
  const counts = {};
  let unknown = 0;
  for (const node of batch?.nodes ?? []) {
    if (node.region) counts[node.region] = (counts[node.region] ?? 0) + 1;
    else unknown += 1;
  }
  return { total: batch?.nodes.length ?? 0, skipped: batch?.skipped ?? 0,
    importedAt: batch?.importedAt ?? null, regions: counts, unknown };
}

function parseSettings(body, previous) {
  const updateRegion = Object.hasOwn(body, 'region');
  const updateHeartbeat = Object.hasOwn(body, 'extraRegions') || Object.hasOwn(body, 'intervals');
  if (!updateRegion && !updateHeartbeat) throw new ApiError(400, '没有可保存的设置。');
  const region = updateRegion ? body.region : previous.region;
  const extraRegions = updateHeartbeat ? body.extraRegions : previous.extraRegions;
  const validRegion = code => typeof code === 'string' && Object.hasOwn(REGIONS, code);
  if (!validRegion(region) || !Array.isArray(extraRegions) || !extraRegions.every(validRegion)) {
    throw new ApiError(400, '请选择有效的地区。');
  }
  const { active, extra } = (updateHeartbeat ? body.intervals : previous.intervals) ?? {};
  if ([active, extra].some((interval) => !Number.isInteger(interval) || interval < 1 || interval > 1440)) {
    throw new ApiError(400, '检查间隔必须是 1 至 1440 分钟之间的整数。');
  }
  return { region, extraRegions: [...new Set(extraRegions)].filter(code => code !== region), intervals: { active, extra } };
}

export async function startApp({
  directory = process.env.CLASH_PRO_DATA_DIR || join(homedir(), 'Library', 'Application Support', 'Clash Pro'),
  port = 17880, downloadPort = 17881,
  clash = createClash(), download = fetchSubscription, validate = validateNodes,
  gateway = createGateway(), verify = verifyPairing,
  emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`), background = true,
} = {}) {
  const personalDirect = await readPersonalDirect(directory);
  const store = await openStore(directory);
  const key = randomBytes(32).toString('base64url');
  const privatePath = `/ui/${key}/`;
  const activeImports = new Set();
  const loadedBatches = {};
  const retired = store.get().retired ?? {};
  const published = { ...Object.fromEntries(Object.entries(retired).map(([id, item]) => [id, item.batch])),
    ...store.get().suppliers };
  let controller = { state: 'offline', message: '正在查找 Clash Verge。' };
  let mutation = Promise.resolve();
  let checking = false;
  let closed = false;
  let devices = [];
  let localTailnet;
  let profilePort;
  const monitor = createMonitor({ store, controller: () => controller.activeMode === 'local' || gateway.snapshot().state === 'ready',
    network: () => Object.entries(networkInterfaces()).some(([name, addresses]) =>
      /^en\d+$/.test(name) && addresses.some(({ address, internal }) =>
        !internal && !/^(?:169\.254\.|fe80:)/i.test(address))),
    probe: (id, name, url) => controller.activeMode === 'local' ? clash.probe(id, name, url) : gateway.probe(name, url),
    emit: (event) => emit({ event: 'alert', ...event }) });

  function run(action) {
    const next = mutation.then(action);
    mutation = next.catch(() => {});
    return next;
  }

  function publicState() {
    const state = store.get();
    const { activeTopology, ...connection } = controller;
    if (connection.state === 'ready' && activeTopology !== topology(state)) {
      connection.needsRefresh = true;
      connection.message = '已保存。请刷新 Clash Verge 中的本机订阅以启用。';
    }
    return {
      region: state.region, extraRegions: state.extraRegions, intervals: state.intervals, regions: REGIONS,
      suppliers: Object.fromEntries(Object.entries(state.suppliers).map(([id, batch]) =>
        [id, { name: state.names[id], ...supplierSummary(batch) }])),
      routes: state.routes,
      supplierNames: { ...Object.fromEntries(Object.entries(state.retired ?? {}).map(([id, item]) => [id, item.name])), ...state.names },
      networkMode: state.networkMode,
      pairing: state.pairing && { host: state.pairing.host, port: state.pairing.port },
      sharing: { enabled: state.sharing.enabled, ...gateway.snapshot(), devices, localAddress: localTailnet,
        peers: state.sharing.peers.map(({ device, name, address }) => ({ device, name, address })) },
      controller: connection, health: monitor.snapshot(), alerts: state.alerts,
      profileURL: `http://127.0.0.1:${profilePort}/profile.yaml?key=${state.token}`,
      downloadPort,
    };
  }

  function updateConnection(current) {
    for (const slot of Object.keys(loadedBatches)) delete loadedBatches[slot];
    controller = current;
  }

  async function syncClash() {
    if (checking || closed) return;
    checking = true;
    try {
      await run(async () => {
        if (closed) return;
        const state = store.get();
        await gateway.sync(state, profilePort);
        const current = await clash.view();
        if (!['managed', 'client'].includes(current.state)) { updateConnection(current); return; }
        const expected = topology(state);
        const applied = Boolean(await clash.hasTopology?.(expected));
        if (current.state === 'managed') {
          for (const [id, batch] of Object.entries(state.suppliers)) {
            if (!batch || loadedBatches[id] === batch.id || (!applied && !await clash.hasProvider?.(id))) continue;
            await clash.updateProvider(id, batch.nodes);
            loadedBatches[id] = batch.id;
          }
          if (current.agent.now !== groupFor('agent', state.region) ||
              current.daily.now !== dailyGroupFor(state.region, current.legacy)) {
            await clash.selectRegion(state.region, current);
            current.agent.now = groupFor('agent', state.region);
            current.daily.now = dailyGroupFor(state.region, current.legacy);
          }
        }
        if (applied && Object.keys(state.retired ?? {}).length) {
          await store.change(value => ({ ...value, retired: {} }));
          for (const id of Object.keys(state.retired)) {
            delete published[id];
            delete loadedBatches[id];
          }
        }
        controller = { state: 'ready', needsRefresh: !applied,
          activeTopology: applied ? expected : null,
          activeMode: current.state === 'client' ? 'client' : 'local',
          activeRoutes: current.state === 'managed' ? (applied ? state.routes : await clash.activeRoutes?.(current)) : null,
          message: applied ? 'Clash Verge 已应用当前配置。' : '已保存。请刷新 Clash Verge 中的本机订阅以启用。' };
      });
    } catch {
      controller = { state: 'error', message: '无法同步 Clash Verge，请确认合并配置已启用且节点集合可访问。' };
    } finally { checking = false; }
  }

  async function importSupplier(body) {
    const slot = body.supplier;
    if (!isSupplier(slot) || !Object.hasOwn(store.get().suppliers, slot) ||
        typeof body.url !== 'string' || body.url.length > 4096 || !body.url.trim()) {
      throw new ApiError(400, '请选择供应商并填写临时订阅链接。');
    }
    if (activeImports.has(slot)) throw new ApiError(409, '该供应商正在导入。');
    activeImports.add(slot);
    try {
      let parsed;
      try {
        parsed = parseSubscription(await download(body.url.trim()), slot);
        await validate(parsed.nodes);
      } catch (error) {
        throw new ApiError(422, error.message || '无法导入节点。');
      }
      await run(async () => {
        if (!Object.hasOwn(store.get().suppliers, slot)) throw new ApiError(409, '该供应商已删除。');
        const batch = { ...parsed, id: randomUUID(), importedAt: new Date().toISOString() };
        const previous = published[slot];
        const current = await clash.view();
        const save = () => store.change((state) => ({ ...state, suppliers: { ...state.suppliers, [slot]: batch } }));
        if (!previous) {
          // An empty slot has nothing to roll back to in Mihomo. Commit the
          // validated first snapshot before offering it to the running core.
          await save();
          published[slot] = batch;
          return;
        }
        published[slot] = batch;
        let updated = false;
        try {
          if (current.state === 'managed' && await clash.hasProvider?.(slot)) {
            updated = true;
            await clash.updateProvider(slot, batch.nodes);
          }
          await save();
          if (updated) loadedBatches[slot] = batch.id;
        } catch {
          published[slot] = previous;
          delete loadedBatches[slot];
          controller = { state: 'error', message: '无法应用新节点，正在同步上一批配置。' };
          if (updated && previous) {
            try {
              await clash.updateProvider(slot, previous.nodes);
              loadedBatches[slot] = previous.id;
            } catch { /* The next sync retries the saved snapshot. */ }
          }
          throw new ApiError(502, '无法应用新节点，上一批保存在本机。');
        }
      });
    } finally { activeImports.delete(slot); }
    if (background) void syncClash();
  }

  async function editSuppliers({ action, id, name }) {
    await run(() => store.change(state => {
      if (action !== 'create' && (!isSupplier(id) || !Object.hasOwn(state.suppliers, id))) {
        throw new ApiError(404, '该供应商不存在。');
      }
      if (action === 'remove') {
        const suppliers = { ...state.suppliers };
        const names = { ...state.names };
        delete suppliers[id];
        delete names[id];
        const routes = Object.fromEntries(LANES.map(lane => [lane, state.routes[lane].filter(value => value !== id)]));
        return { ...state, suppliers, names, routes,
          retired: { ...state.retired, [id]: { name: state.names[id], batch: state.suppliers[id] } } };
      }
      const clean = typeof name === 'string' ? name.trim() : '';
      if (!clean || clean.length > 60 || /[\u0000-\u001f\u007f]/.test(clean)) {
        throw new ApiError(400, '供应商名称须为 1 到 60 个字符。');
      }
      if (action === 'rename') return { ...state, names: { ...state.names, [id]: clean } };
      if (action !== 'create') throw new ApiError(400, '未知操作。');
      if (Object.keys(state.suppliers).length >= 32) throw new ApiError(400, '已达到 32 个供应商的上限。');
      let supplier;
      do { supplier = newSupplier(); }
      while (Object.hasOwn(state.suppliers, supplier) || Object.hasOwn(state.retired ?? {}, supplier));
      return { ...state, suppliers: { ...state.suppliers, [supplier]: null }, names: { ...state.names, [supplier]: clean } };
    }));
  }

  async function editRoutes(body) {
    await run(() => store.change(state => {
      const routes = Object.fromEntries(LANES.map(lane => {
        const order = body[lane];
        if (!Array.isArray(order) || order.some(id => !isSupplier(id) || !Object.hasOwn(state.suppliers, id)) ||
            new Set(order).size !== order.length) throw new ApiError(400, '请为每条线路设置有效且不重复的供应商。');
        return [lane, order];
      }));
      return { ...state, routes };
    }));
  }

  async function scanDevices() {
    try {
      const info = await gateway.scan({ force: true });
      devices = info.peers;
      localTailnet = info.address;
      return info;
    } catch (error) {
      devices = [];
      localTailnet = undefined;
      throw new ApiError(409, error.message);
    }
  }

  async function editGateway({ action, device }) {
    if (action === 'scan') { await scanDevices(); return {}; }
    if (!['enable', 'disable', 'authorize', 'revoke', 'rotate', 'code'].includes(action)) {
      throw new ApiError(400, '未知共享操作。');
    }
    const tailnet = ['enable', 'authorize', 'rotate', 'code'].includes(action) ? await scanDevices() : null;
    return run(async () => {
      const state = store.get();
      const { sharing } = state;
      const old = sharing.peers.find(peer => peer.device === device);
      if (state.networkMode === 'client') throw new ApiError(409, '请先切换到本机供应商模式。');
      if (action === 'code') {
        if (!old || !tailnet.peers.some(peer => peer.id === old.device && peer.address === old.address)) {
          throw new ApiError(404, '该设备未授权，或其 Tailscale 地址已改变。');
        }
        return { pairingCode: encodePairing(tailnet.address, old, gateway.snapshot().port) };
      }
      let peers = sharing.peers;
      if (action === 'authorize' || action === 'rotate') {
        const found = tailnet.peers.find(peer => peer.id === device);
        if (!found) throw new ApiError(404, '当前 Tailscale 网络中没有该设备。');
        if (!old && peers.length >= 16) throw new ApiError(400, '已达到 16 台授权设备的上限。');
        if (!old || action === 'rotate' || old.address !== found.address) {
          peers = [...peers.filter(peer => peer.device !== device), newPeer(found)];
        }
      }
      if (action === 'revoke') peers = peers.filter(peer => peer.device !== device);
      const enabled = action === 'enable' || action === 'authorize' || (action !== 'disable' && sharing.enabled);
      const saved = await store.change(value => ({ ...value, sharing: { enabled, peers } }));
      await gateway.sync(saved, profilePort);
      return {};
    });
  }

  async function editPairing({ action, code }) {
    if (action === 'local') {
      await run(() => store.change(value => ({ ...value, networkMode: 'local' })));
      return;
    }
    if (action !== 'connect') throw new ApiError(400, '未知配对操作。');
    const tailnet = await scanDevices();
    let pairing;
    try {
      pairing = decodePairing(code, tailnet);
      await verify(pairing);
    } catch (error) { throw new ApiError(422, error.message); }
    await run(async () => {
      const saved = await store.change(value => ({ ...value, pairing, networkMode: 'client',
        sharing: { ...value.sharing, enabled: false } }));
      await gateway.sync(saved, profilePort);
    });
  }

  async function writeSettings(body) {
    await run(async () => {
      const previous = store.get();
      const settings = parseSettings(body, previous);
      const switching = previous.region !== settings.region;
      const current = switching ? await clash.view() : null;
      let changed = false;
      try {
        if (current?.state === 'managed') {
          await clash.selectRegion(settings.region, current);
          changed = true;
        }
        await store.change((state) => ({ ...state, ...settings }));
      } catch (error) {
        if (changed) {
          const now = await clash.view();
          if (now.state === 'managed') {
            try { await clash.selectRegion(previous.region, now); } catch { /* The next sync restores the saved region. */ }
          }
        }
        throw new ApiError(502, error.message || '无法保存设置。');
      }
    });
  }

  const server = createServer(async (req, res) => {
    try {
      if (req.headers.host !== `127.0.0.1:${profilePort}`) throw new ApiError(403, '无效的本机地址。');
      const address = new URL(req.url, `http://127.0.0.1:${profilePort}`);
      const path = address.pathname;
      const state = store.get();
      if (req.method === 'GET' && path === '/profile.yaml' && matchToken(address.searchParams.get('key'), state.token)) {
        return respond(res, 200, 'text/yaml; charset=utf-8',
          buildProfile({ port: profilePort, state, downloadPort, personalDirect }));
      }
      const ruleName = /^\/rules\/([a-z0-9-]+)\.mrs$/.exec(path)?.[1];
      if (req.method === 'GET' && ruleName && matchToken(req.headers.authorization, `Bearer ${state.token}`)) {
        const rule = await readRuleAsset(ruleName);
        if (rule) return respond(res, 200, 'application/octet-stream', rule);
      }
      const slot = /^\/providers\/([A-Za-z0-9]+)\.yaml$/.exec(path)?.[1];
      if (req.method === 'GET' && isSupplier(slot) && (Object.hasOwn(state.suppliers, slot) || Object.hasOwn(state.retired ?? {}, slot)) &&
          matchToken(req.headers.authorization, `Bearer ${state.token}`)) {
        return respond(res, 200, 'text/yaml; charset=utf-8', encodeProvider(published[slot]?.nodes ?? []));
      }
      if (!path.startsWith(privatePath)) throw new ApiError(404, '找不到本机资源。');
      const page = path.slice(privatePath.length);
      if (req.method === 'GET' && page === 'api/state') return json(res, 200, publicState());
      const detailId = /^api\/suppliers\/([A-Za-z0-9]+)\/nodes$/.exec(page)?.[1];
      if (req.method === 'GET' && isSupplier(detailId) && Object.hasOwn(state.suppliers, detailId)) {
        return json(res, 200, { nodes: supplierNodeDetails(state.suppliers[detailId]?.nodes) });
      }
      if (req.method === 'GET' && Object.hasOwn(assets, page)) {
        const [name, type] = assets[page];
        return respond(res, 200, type, await readFile(new URL(`public/${name}`, import.meta.url)));
      }
      const actions = { 'api/import': importSupplier, 'api/settings': writeSettings, 'api/suppliers': editSuppliers,
        'api/routes': editRoutes, 'api/gateway': editGateway, 'api/pairing': editPairing };
      if (req.method === 'POST' && Object.hasOwn(actions, page)) {
        if (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${profilePort}`) {
          throw new ApiError(403, '无效的来源。');
        }
        const body = await readBody(req);
        const extra = await actions[page](body);
        if (background) void syncClash();
        return json(res, 200, { ...publicState(), ...extra });
      }
      throw new ApiError(404, '找不到本机资源。');
    } catch (error) {
      if (!res.headersSent && !res.destroyed) {
        json(res, error instanceof ApiError ? error.status : 500,
          { error: error instanceof ApiError ? error.message : '本机处理失败，请重试。' });
      }
    }
  });

  await new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => { server.off('error', fail); ok(); });
  });
  profilePort = server.address().port;
  const url = `http://127.0.0.1:${profilePort}${privatePath}`;
  let checkTimer, monitorTimer;
  if (background) {
    checkTimer = setInterval(() => { void syncClash(); }, 5_000);
    monitorTimer = setInterval(() => { void monitor.tick().catch(() => {}); }, 2_000);
    void syncClash();
  }
  return { url, syncClash, monitor, async close() {
    closed = true;
    clearInterval(checkTimer);
    clearInterval(monitorTimer);
    await run(() => gateway.close());
    await new Promise((ok) => server.close(ok));
  } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
  try {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 22 || (major === 22 && minor < 12)) throw Object.assign(new Error(), { code: 'OLD_NODE' });
    const app = await startApp({ emit });
    emit({ event: 'ready', url: app.url });
    let closing = false;
    function stop() {
      if (closing) return;
      closing = true;
      const timer = setTimeout(() => process.exit(0), 1_200);
      timer.unref();
      void app.close().finally(() => process.exit(0));
    }
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);
    if (process.argv.includes('--desktop')) {
      process.stdin.once('end', stop);
      process.stdin.resume();
    }
  } catch (error) {
    const messages = { EADDRINUSE: '本机 17880 端口已被占用。',
      OLD_NODE: '需要 Node.js 22.12 或更新版本。', PERSONAL_RULES: error.message };
    emit({ event: 'error', message: messages[error.code] ?? '无法启动 Clash Pro，请检查本机数据目录。' });
    process.exitCode = 1;
  }
}
