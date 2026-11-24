import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, createConnection, isIPv4 } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { promisify } from 'node:util';
import { stringify } from 'yaml';
import { control, defaultCore } from './clash.mjs';
import { buildGatewayProfile, JUMP, jumpProxy } from './profiles.mjs';

export const SHARE_PORT = 17882;
const exec = promisify(execFile);
const addressPattern = /^100\.(\d+)\./;
const pairingPrefix = 'clash-pro:';
const probeURL = 'https://www.gstatic.com/generate_204';
const loopback = '127.0.0.1';

export function isTailnetIP(address) {
  if (typeof address !== 'string' || !isIPv4(address)) return false;
  const second = Number(addressPattern.exec(address)?.[1]);
  return second >= 64 && second <= 127;
}

export async function detectTailnet() {
  const binaries = ['/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale',
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
  for (const binary of binaries) {
    try {
      const { stdout } = await exec(binary, ['status', '--json'], {
        env: { ...process.env, TAILSCALE_BE_CLI: '1' }, timeout: 2500, maxBuffer: 2 * 1024 ** 2,
      });
      const status = JSON.parse(stdout);
      const address = status.Self?.TailscaleIPs?.find(isTailnetIP);
      const local = Object.entries(networkInterfaces()).some(([name, addrs]) =>
        name.startsWith('utun') && addrs.some(info => info.address === address));
      if (status.BackendState !== 'Running' || !address || !local) break;
      const peers = Object.values(status.Peer ?? {}).filter(peer => peer.ID && peer.TailscaleIPs?.some(isTailnetIP))
        .map(peer => ({ id: peer.ID, name: peer.HostName || peer.DNSName || '设备', address: peer.TailscaleIPs.find(isTailnetIP) }));
      return { address, peers };
    } catch { /* Try the next supported macOS installation. */ }
  }
  throw new Error('请先连接本机 Tailscale，再重试。');
}

async function physicalInterface() {
  const result = await new Promise(resolve => {
    const child = execFile('/usr/sbin/scutil', [], { timeout: 2000 }, (error, output) => resolve(error ? '' : output));
    child.stdin.on('error', () => {});
    child.stdin.end('show State:/Network/Global/IPv4\n');
  });
  const name = /PrimaryInterface\s*:\s*(en\d+)\b/.exec(result)?.[1];
  if (!name || !networkInterfaces()[name]?.some(info => !info.internal)) {
    throw new Error('未找到可用于跳板出站的本机网络接口。');
  }
  return name;
}

export function newPeer(device) {
  return { device: device.id, id: randomBytes(6).toString('hex'), name: device.name,
    address: device.address, key: randomBytes(16).toString('base64') };
}

export function encodePairing(host, peer, port = SHARE_PORT) {
  const data = { version: 1, host, target: peer.address, port, key: peer.key };
  return pairingPrefix + Buffer.from(JSON.stringify(data)).toString('base64url');
}

export function decodePairing(code, tailnet) {
  const raw = typeof code === 'string' ? code.trim() : '';
  if (!raw.startsWith(pairingPrefix) || !/^[\w-]{1,1024}$/.test(raw.slice(pairingPrefix.length))) {
    throw new Error('配对码格式无效。');
  }
  let data;
  try { data = JSON.parse(Buffer.from(raw.slice(pairingPrefix.length), 'base64url')); }
  catch { throw new Error('配对码格式无效。'); }
  if (data?.version !== 1 || !isTailnetIP(data.target) || !isTailnetIP(data.host) || data.host === data.target ||
      !Number.isInteger(data.port) || data.port < 1024 || data.port > 65535 ||
      typeof data.key !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(data.key) ||
      Buffer.from(data.key, 'base64').toString('base64') !== data.key) {
    throw new Error('配对码格式无效。');
  }
  if (data.target !== tailnet.address || !tailnet.peers.some(peer => peer.address === data.host)) {
    throw new Error('该配对码不属于本机，或者跳板未出现在当前 Tailscale 网络。');
  }
  return { id: randomUUID(), host: data.host, target: data.target, port: data.port, key: data.key };
}

function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(server.address().port); });
  });
}

function bindUDP(socket, host, port) {
  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(port, host, () => { socket.off('error', reject); resolve(); });
  });
}

const closeUDP = socket => { try { socket.close(); } catch { /* Not bound yet. */ } };

async function backendPort() {
  const tcp = createServer();
  const udp = createSocket('udp4');
  try {
    const port = await listen(tcp, loopback, 0);
    await bindUDP(udp, loopback, port);
    return port;
  } finally {
    if (tcp.listening) await new Promise(resolve => tcp.close(resolve));
    closeUDP(udp);
  }
}

export async function startCore(profile, binary = defaultCore) {
  const directory = await mkdtemp('/tmp/clash-pro-core.');
  const socket = join(directory, 'core.sock');
  const file = join(directory, 'config.yaml');
  let child;
  let exited;
  let ended = false;
  async function close() {
    if (child && !ended) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => { if (!ended) child.kill('SIGKILL'); }, 500);
      try { await exited; } finally { clearTimeout(timer); }
    }
    await rm(directory, { recursive: true, force: true });
  }
  try {
    await writeFile(file, stringify(profile), { flag: 'wx', mode: 0o600 });
    child = spawn(binary, ['-d', directory, '-f', file, '-ext-ctl-unix', socket], { stdio: 'ignore' });
    exited = new Promise(resolve => child.once('close', () => { ended = true; resolve(); }));
    child.on('error', () => {});
    for (let attempt = 0; attempt < 50 && !ended; attempt++) {
      if ((await control(socket, '/version').catch(() => null))?.status === 200) {
        return { socket, close, exited, alive: () => !ended };
      }
      await pause(120);
    }
    throw new Error('Mihomo 未能启动独立跳板内核，请检查安装和端口。');
  } catch (error) {
    await close();
    throw error;
  }
}

async function probeAdapter(core, name, url = probeURL, expected = url === probeURL ? '204' : '200-299') {
  const query = new URLSearchParams({ url, timeout: '4500', expected });
  try {
    const result = await control(core.socket, `/proxies/${encodeURIComponent(name)}/delay?${query}`, { timeout: 5600 });
    if (result.status === 200 && Number.isFinite(result.data?.delay)) return true;
    return [408, 500, 503, 504].includes(result.status) ? false : null;
  } catch { return null; }
}

export async function verifyPairing(pairing, binary = defaultCore) {
  const core = await startCore({ mode: 'rule', proxies: [jumpProxy(pairing)], rules: ['MATCH,REJECT'] }, binary);
  try {
    const results = await Promise.all([probeAdapter(core, JUMP),
      probeAdapter(core, JUMP, 'https://api.openai.com/v1/models', '200-499')]);
    if (!results.includes(true)) throw new Error('无法通过跳板访问探测站。请检查设备授权和跳板机的代理线路。');
  } finally { await core.close(); }
}

export async function openRelay(host, port) {
  const peers = new Map();
  const streams = new Set();
  const datagrams = new Map();
  let closed = false;
  const tcp = createServer({ pauseOnConnect: true }, socket => {
    const address = socket.remoteAddress;
    const target = peers.get(address);
    if (closed || !target || streams.size >= 512 || [...streams].filter(item => item.address === address).length >= 128) {
      socket.destroy();
      return;
    }
    const back = createConnection(target.backend, loopback);
    const entry = { address, target, stop() { socket.destroy(); back.destroy(); streams.delete(entry); } };
    streams.add(entry);
    socket.once('error', entry.stop);
    back.once('error', entry.stop);
    socket.once('close', entry.stop);
    back.once('close', entry.stop);
    socket.pipe(back).pipe(socket);
  });
  const udp = createSocket('udp4');

  function remove(key, entry) {
    datagrams.delete(key);
    closeUDP(entry.socket);
  }

  udp.on('message', (bytes, sender) => {
    const target = peers.get(sender.address);
    if (closed || !target) return;
    const key = `${sender.address}:${sender.port}`;
    let entry = datagrams.get(key);
    if (!entry) {
      if (datagrams.size >= 512 || [...datagrams.values()].filter(item => item.address === sender.address).length >= 128) return;
      const socket = createSocket('udp4');
      entry = { address: sender.address, target, socket, touched: Date.now(), pending: [], ready: false };
      datagrams.set(key, entry);
      const current = entry;
      socket.on('error', () => { if (datagrams.get(key) === current) remove(key, current); });
      socket.on('message', reply => {
        if (peers.get(sender.address) !== target || datagrams.get(key) !== current) return;
        current.touched = Date.now();
        udp.send(reply, sender.port, sender.address, () => {});
      });
      socket.bind(0, loopback, () => {
        if (datagrams.get(key) !== current) return;
        socket.connect(target.backend, loopback, () => {
          if (datagrams.get(key) !== current) return;
          current.ready = true;
          for (const message of current.pending) socket.send(message, () => {});
          current.pending = [];
        });
      });
    }
    entry.touched = Date.now();
    if (entry.ready) entry.socket.send(bytes, () => {});
    else if (entry.pending.length < 8) entry.pending.push(bytes);
  });

  function configure(next) {
    const remaining = new Set(next.map(({ address }) => address));
    for (const address of peers.keys()) if (!remaining.has(address)) peers.delete(address);
    for (const peer of next) {
      const old = peers.get(peer.address);
      if (old?.backend !== peer.backend || old?.id !== peer.id) peers.set(peer.address, peer);
    }
    for (const entry of streams) if (peers.get(entry.address) !== entry.target) entry.stop();
    for (const [key, entry] of datagrams) if (peers.get(entry.address) !== entry.target) remove(key, entry);
  }

  let bound;
  try {
    bound = await listen(tcp, host, port);
    await bindUDP(udp, host, bound);
  } catch (error) {
    if (tcp.listening) await new Promise(resolve => tcp.close(resolve));
    closeUDP(udp);
    throw error;
  }
  const sweep = setInterval(() => {
    const cutoff = Date.now() - 120_000;
    for (const [key, entry] of datagrams) if (entry.touched < cutoff) remove(key, entry);
  }, 15_000);
  sweep.unref();

  async function close() {
    if (closed) return;
    closed = true;
    clearInterval(sweep);
    configure([]);
    closeUDP(udp);
    await new Promise(resolve => tcp.close(resolve));
  }
  tcp.on('error', () => void close());
  udp.on('error', () => void close());
  return { configure, close, port: bound, alive: () => !closed };
}

export function createGateway({ discover = detectTailnet, outbound = physicalInterface, binary = defaultCore,
  sharePort = SHARE_PORT } = {}) {
  let running;
  let status = { state: 'off' };
  let closed = false;
  let tailnet;
  let lastScan = 0;

  async function scan({ force = false } = {}) {
    if (!force && tailnet && Date.now() - lastScan < 5_000) return tailnet;
    tailnet = await discover();
    lastScan = Date.now();
    return tailnet;
  }

  async function stop() {
    const previous = running;
    running = undefined;
    if (previous) {
      await previous.relay?.close();
      await previous.core?.close();
    }
  }

  async function sync(state, port) {
    if (closed || !state.sharing.enabled || state.networkMode !== 'local') {
      status = { state: 'off' };
      await stop();
      return status;
    }
    let next;
    try {
      const local = await scan();
      const valid = state.sharing.peers.filter(peer => local.peers.some(item =>
        peer.device === item.id && peer.address === item.address));
      const changedHost = running && running.host !== local.address;
      if (changedHost || (running && (!running.core.alive() || !running.relay.alive()))) await stop();
      running?.relay.configure(running.peers.filter(peer => valid.some(item => peer.id === item.id && peer.key === item.key)));
      if (!valid.length) {
        await stop();
        return status = { state: 'waiting', address: local.address, message: '请授权一台当前 Tailscale 网络中的设备。' };
      }
      const outboundInterface = await outbound();
      const panels = await Promise.all(valid.map(async peer => {
        const previous = running?.peers.find(item => item.device === peer.device);
        return { ...peer, backend: previous?.backend ?? await backendPort() };
      }));
      const profile = buildGatewayProfile({ port, state, peers: panels, outboundInterface });
      const payload = stringify(profile);
      const digest = createHash('sha256').update(payload).digest('hex');
      if (running?.digest === digest) return status;
      if (running) {
        const result = await control(running.core.socket, '/configs?force=true', {
          method: 'PUT', body: { payload }, timeout: 10_000,
        });
        if (result.status !== 204) throw new Error('独立 Mihomo 拒绝加载跳板配置。');
        next = running;
      } else {
        next = { core: await startCore(profile, binary), host: local.address };
        next.relay = await openRelay(local.address, sharePort);
        next.core.exited.then(() => {
          if (running !== next) return;
          status = { state: 'error', message: '独立 Mihomo 已退出，正在等待重试。' };
          void next.relay.close();
        });
      }
      next.relay.configure(panels);
      Object.assign(next, { digest, peers: panels });
      running = next;
      return status = { state: 'ready', address: local.address, port: next.relay.port, peers: panels.map(peer => peer.device) };
    } catch (error) {
      if (next && next !== running) {
        await next.relay?.close();
        await next.core?.close();
      }
      await stop();
      return status = { state: 'error', message: error.code === 'EADDRINUSE'
        ? '跳板端口已被占用。' : error.message || '跳板共享启动失败。' };
    }
  }

  return {
    scan, sync, snapshot: () => ({ ...status }),
    async probe(name, url) { return running ? probeAdapter(running.core, name, url) : null; },
    async close() { closed = true; await stop(); },
  };
}
