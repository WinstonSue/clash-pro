import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { AGENT_SELECTOR, DAILY_SELECTOR, LEGACY_DOWNLOAD_SELECTOR, JUMP, groupFor, PROBE_URL, encodeProvider } from './profiles.mjs';
import { allowlistName } from './routing.mjs';
import { isSupplier, LANES, providerName } from './suppliers.mjs';

const execute = promisify(execFile);
const agentPath = `/proxies/${encodeURIComponent(AGENT_SELECTOR)}`;
const dailyPath = `/proxies/${encodeURIComponent(DAILY_SELECTOR)}`;
const legacyDownloadPath = `/proxies/${encodeURIComponent(LEGACY_DOWNLOAD_SELECTOR)}`;
const providerPath = supplier => `/providers/proxies/${encodeURIComponent(providerName(supplier))}`;
const proxyPath = name => `/proxies/${encodeURIComponent(name)}`;

export function dailyGroupFor(region, legacy) {
  return legacy ? `${LEGACY_DOWNLOAD_SELECTOR}-${region}` : groupFor('daily', region);
}

export const defaultSocket = `/var/run/clash-verge-service/users/${process.getuid()}/verge-mihomo.sock`;
const sidecarSocket = join(tmpdir(), 'verge-mihomo.sock');
export const defaultCore = '/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo';

export async function validateNodes(nodes, binary = defaultCore) {
  const directory = await mkdtemp(join(tmpdir(), 'clash-pro-check-'));
  const file = join(directory, 'config.yaml');
  try {
    await writeFile(file, `${encodeProvider(nodes)}\nrules:\n  - MATCH,DIRECT\n`, { mode: 0o600 });
    await execute(binary, ['-t', '-d', directory, '-f', file], { timeout: 8_000, maxBuffer: 64 * 1024 });
  } catch {
    throw new Error('Mihomo 节点校验失败。请确认已安装 Clash Verge，并使用 Clash / Mihomo 格式的订阅。');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function control(socketPath, path, { method = 'GET', body, timeout = 2_500 } = {}) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = request({ socketPath, path, method, headers: payload && {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload),
      } }, (response) => {
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) req.destroy(new Error('Mihomo 响应超过大小限制。'));
          else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          let data;
          try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { data = null; }
          resolve({ status: response.statusCode, data });
        });
      });
      req.setTimeout(timeout, () => req.destroy(new Error('Mihomo 响应超时。')));
      req.on('error', reject);
      req.end(payload);
    });
}

export function createClash(socketPath) {
  function call(path, options) {
    if (socketPath) return control(socketPath, path, options);
    return control(defaultSocket, path, options).catch(error => {
      // Service and sidecar use different Unix sockets. Retry only when the
      // service connection could not be opened, before sending a mutation.
      if (!['ENOENT', 'ECONNREFUSED', 'EACCES', 'EPERM'].includes(error.code)) throw error;
      return control(sidecarSocket, path, options);
    });
  }

  async function view() {
    try {
      const [agent, daily] = await Promise.all([call(agentPath), call(dailyPath)]);
      if (agent.data?.type !== 'Selector') {
        if ((await call(proxyPath(JUMP))).data?.type === 'Shadowsocks') return { state: 'client' };
        return { state: 'unmanaged', message: '请在 Clash Verge 导入并启用本机合并配置。' };
      }
      const legacy = daily.data?.type !== 'Selector';
      const currentDaily = legacy ? (await call(legacyDownloadPath)).data : daily.data;
      if (!agent.data?.all?.includes(groupFor('agent', 'JP')) || currentDaily?.type !== 'Selector' ||
          !currentDaily.all?.includes(dailyGroupFor('JP', legacy))) {
        return { state: 'unmanaged', message: '当前运行的配置和本应用不匹配。' };
      }
      return { state: 'managed', agent: agent.data, daily: currentDaily, legacy };
    } catch {
      return { state: 'offline', message: '未连接 Clash Verge。请确认内核正在运行。' };
    }
  }

  async function activeRoutes(current) {
    if (current.state !== 'managed') return null;
    const orders = await Promise.all([current.agent, current.daily].map(async ({ now }) => {
      const reply = await call(proxyPath(now));
      const nodes = reply.data?.all ?? [];
      return [...new Set(nodes.map(name => name.split('-', 1)[0]).filter(isSupplier))];
    }));
    return { agent: orders[0], daily: orders[1] };
  }

  async function allowlistStatus() {
    try {
      const active = await call('/rules');
      if (active.status !== 200 || !Array.isArray(active.data?.rules)) return 'offline';
      const names = LANES.map(allowlistName);
      const referenced = active.data.rules
        .filter(rule => rule.type === 'RuleSet' && rule.proxy !== 'REJECT')
        .map(rule => rule.payload);
      if (!names.every(name => referenced.includes(name))) return 'unreferenced';
      const response = await call('/providers/rules');
      const providers = response.data?.providers;
      if (response.status !== 200 || !providers || typeof providers !== 'object') return 'offline';
      return names.every(name => {
        const provider = providers[name];
        return Number.isInteger(provider?.ruleCount) && provider.ruleCount >= 0 && Date.parse(provider.updatedAt) > 0;
      }) ? 'loaded' : 'loading';
    } catch {
      return 'offline';
    }
  }

  async function select(path, name) {
    const reply = await call(path, { method: 'PUT', body: { name } });
    if (reply.status !== 204) throw new Error('Mihomo 拒绝切换地区。');
  }

  async function selectRegion(region, current) {
    const targets = [[agentPath, groupFor('agent', region), current.agent],
      [current.legacy ? legacyDownloadPath : dailyPath, dailyGroupFor(region, current.legacy), current.daily]];
    if (targets.some(([, name, group]) => !group.all.includes(name))) {
      throw new Error('运行配置中缺少这个地区。请在 Clash Verge 更新本机合并配置。');
    }
    const changed = [];
    try {
      for (const [path, name, group] of targets) {
        if (name === group.now) continue;
        changed.push([path, group.now]);
        await select(path, name);
      }
      const check = await view();
      if (check.agent?.now !== targets[0][1] || check.daily?.now !== targets[1][1]) {
        throw new Error('无法确认两条线路已切换到同一地区。');
      }
    } catch (error) {
      const restore = await Promise.allSettled(changed.map(([path, name]) => select(path, name)));
      if (restore.some(({ status }) => status === 'rejected')) {
        throw new Error('地区切换中断，无法确认 Clash Verge 已恢复原地区。');
      }
      throw error;
    }
  }

  async function updateProvider(supplier, nodes) {
    const path = providerPath(supplier);
    const reply = await call(path, { method: 'PUT', timeout: 12_000 });
    if (reply.status !== 204) throw new Error('Mihomo 未能加载本机节点集合。');
    const check = await call(path);
    const names = new Set(check.data?.proxies?.map(({ name }) => name));
    if (check.status !== 200 || names.size !== nodes.length || nodes.some(({ proxy }) => !names.has(proxy.name))) {
      throw new Error('本机节点集合与 Mihomo 加载结果不一致。');
    }
  }

  async function probe(supplier, name, url) {
    const path = `${providerPath(supplier)}/${encodeURIComponent(name)}`;
    const threshold = url === PROBE_URL ? '204' : '200-299';
    const start = Date.now();
    const result = await call(`${path}/healthcheck?${new URLSearchParams({ url, timeout: '4500', expected: threshold })}`,
      { timeout: 6_500 });
    // A positive delay can still carry an unexpected HTTP status. Verify the
    // health record for this specific URL, which is what Mihomo uses to switch.
    if (![200, 408, 503, 504].includes(result.status)) return null;
    const next = await call(path);
    const detail = next.data?.extra?.[url];
    const sample = detail?.history?.at(-1);
    const observed = Date.parse(sample?.time);
    if (!Number.isFinite(observed) || observed < start - 500 || typeof detail.alive !== 'boolean') return null;
    return detail.alive;
  }

  return { view, selectRegion, updateProvider, probe, activeRoutes, allowlistStatus,
    async hasProvider(id) { return (await call(providerPath(id))).status === 200; },
    async hasTopology(name) { return (await call(proxyPath(name))).status === 200; } };
}
