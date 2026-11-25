import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { parseDocument, stringify } from 'yaml';
import { gatewayRules, routingRules, ruleProviders } from './routing.mjs';
import { isSupplier, LANES, providerName, topology } from './suppliers.mjs';

export const REGIONS = Object.freeze({
  JP: '日本', HK: '香港', SG: '新加坡', TW: '台湾', US: '美国', KR: '韩国',
  DE: '德国', GB: '英国', AU: '澳大利亚', MY: '马来西亚', CA: '加拿大',
  FR: '法国', NL: '荷兰', CH: '瑞士', SE: '瑞典', FI: '芬兰', TR: '土耳其',
  IN: '印度', ID: '印度尼西亚', TH: '泰国', VN: '越南', PH: '菲律宾',
  BR: '巴西', AR: '阿根廷', RU: '俄罗斯', MO: '澳门', AE: '阿联酋',
  ES: '西班牙', IT: '意大利', NZ: '新西兰', ZA: '南非',
});

const aliases = {
  JP: /日本|东京|東京|大阪|名古屋|埼玉|japan|tokyo|osaka|saitama/i,
  HK: /香港|港岛|港島|hong[\s_-]*kong/i,
  SG: /新加坡|新國|狮城|獅城|singapore/i,
  TW: /台湾|臺灣|台灣|台北|臺北|taiwan|taipei/i,
  US: /美国|美國|洛杉矶|洛杉磯|纽约|紐約|西雅图|西雅圖|圣何塞|芝加哥|达拉斯|波特兰|硅谷|United[\s_-]*States|Los[\s_-]*Angeles|New[\s_-]*York|Seattle|San[\s_-]*(Jose|Francisco)|Dallas|Chicago/i,
  KR: /韩国|韓國|首尔|首爾|春川|(?:South[\s_-]*)?Korea|Seoul/i,
  DE: /德国|德國|法兰克福|法蘭克福|germany|frankfurt/i,
  GB: /英国|英國|伦敦|倫敦|United[\s_-]*Kingdom|London|\bUK\b/i,
  AU: /澳大利亚|澳大利亞|澳洲|悉尼|雪梨|australia|sydney/i,
  MY: /马来西亚|馬來西亞|吉隆坡|malaysia|Kuala[\s_-]*Lumpur/i,
  CA: /加拿大|多伦多|多倫多|温哥华|溫哥華|canada|toronto|vancouver/i,
  FR: /法国|法國|巴黎|france|paris/i,
  NL: /荷兰|荷蘭|阿姆斯特丹|netherlands|amsterdam/i,
  CH: /瑞士|苏黎世|蘇黎世|switzerland|zürich|zurich/i,
  SE: /瑞典|斯德哥尔摩|sweden|stockholm/i,
  FI: /芬兰|芬蘭|赫尔辛基|finland|helsinki/i,
  TR: /土耳其|伊斯坦布尔|turkey|istanbul/i,
  IN: /印度(?!尼西亚|尼西亞)|孟买|孟買|\bindia\b|mumbai/i,
  ID: /印度尼西亚|印度尼西亞|印尼|雅加达|雅加達|indonesia|jakarta/i,
  TH: /泰国|泰國|曼谷|thailand|bangkok/i,
  VN: /越南|河内|河內|vietnam|hanoi/i,
  PH: /菲律宾|菲律賓|马尼拉|馬尼拉|philippines|manila/i,
  BR: /巴西|圣保罗|聖保羅|brazil|s[aã]o[\s_-]*paulo/i,
  AR: /阿根廷|argentina/i,
  RU: /俄罗斯|俄羅斯|莫斯科|russia|moscow/i,
  MO: /澳门|澳門|macao|macau/i,
  AE: /阿联酋|阿聯酋|迪拜|dubai/i,
  ES: /西班牙|马德里|馬德里|spain|madrid/i,
  IT: /意大利|義大利|米兰|米蘭|italy|milan/i,
  NZ: /新西兰|新西蘭|紐西蘭|奥克兰|奧克蘭|new[\s_-]*zealand|auckland/i,
  ZA: /南非|south[\s_-]*africa/i,
};

const regionCodes = new RegExp(
  `(?:^|[^a-zA-Z0-9])(${Object.keys(REGIONS).join('|')}|UK)(?=$|[^a-zA-Z])`,
);
const leadingRegionCode = new RegExp(
  `^(${Object.keys(REGIONS).join('|')}|UK)(?=\\d|[ _-]+\\d)`,
  'i',
);

export const AGENT_SELECTOR = 'ClashPro-Agent';
export const DAILY_SELECTOR = 'ClashPro-Daily';
export const LEGACY_DOWNLOAD_SELECTOR = 'ClashPro-Download';
export const JUMP = 'ClashPro-Jump';
export const JUMP_CIPHER = '2022-blake3-aes-128-gcm';
export const PROBE_URL = 'https://www.gstatic.com/generate_204';
export const SECONDARY_PROBE_URL = 'https://cp.cloudflare.com/';
const DOWNLOAD_INBOUND = 'ClashPro-Download-In';

export function groupFor(lane, region) {
  return `${lane === 'agent' ? AGENT_SELECTOR : DAILY_SELECTOR}-${region}`;
}

function regionOf(name) {
  const flags = name.matchAll(/[\u{1F1E6}-\u{1F1FF}]{2}/gu);
  for (const [flag] of flags) {
    const code = String.fromCharCode(...Array.from(flag, part => part.codePointAt(0) - 0x1f1e6 + 65));
    if (Object.hasOwn(REGIONS, code)) return code;
  }

  let earliest = null;
  for (const [code, pattern] of Object.entries(aliases)) {
    const match = pattern.exec(name);
    if (match && (!earliest || match.index < earliest.index)) earliest = { code, index: match.index };
  }
  if (earliest) return earliest.code;

  const code = (name.match(regionCodes)?.[1] ?? name.match(leadingRegionCode)?.[1])?.toUpperCase();
  return code === 'UK' ? 'GB' : code ?? null;
}

function hostOf(raw) {
  if (typeof raw !== 'string') return null;
  const host = raw.trim().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '');
  if (isIP(host) === 6) return new URL(`http://[${host}]/`).hostname.slice(1, -1);
  if (isIP(host) === 4) return host;

  if (!host || /[\s\/:@?#]/.test(host)) return null;
  const ascii = domainToASCII(host).toLowerCase();
  if (!ascii || ascii.length > 253) return null;
  const valid = ascii.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
  return valid ? ascii : null;
}

function portOf(raw) {
  const port = typeof raw === 'string' && /^\d{1,5}$/.test(raw) ? Number(raw) : raw;
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const validators = {
  string: value => typeof value === 'string' && value.length > 0 && value.length <= 8192,
  boolean: value => typeof value === 'boolean',
  integer: value => Number.isSafeInteger(value) && value >= 0,
  strings: value => Array.isArray(value) && value.length <= 32 &&
    value.every(part => validators.string(part)),
  headers: value => isObject(value) && Object.keys(value).length <= 32 &&
    Object.entries(value).every(([key, part]) =>
      /^[a-zA-Z0-9!#$%&'*+.^_`|~-]+$/.test(key) &&
      [part].flat().length <= 32 &&
      [part].flat().every(item => validators.string(item) && !/[\r\n]/.test(item))),
};

const sharedOptions = {
  udp: 'boolean', tls: 'boolean', sni: 'string', servername: 'string', alpn: 'strings',
  'skip-cert-verify': 'boolean', 'client-fingerprint': 'string', fingerprint: 'string',
  'udp-over-tcp': 'boolean', 'udp-over-tcp-version': 'integer',
};

const transportOptions = {
  'ws-opts': { path: 'string', headers: 'headers', 'max-early-data': 'integer',
    'early-data-header-name': 'string', 'v2ray-http-upgrade': 'boolean',
    'v2ray-http-upgrade-fast-open': 'boolean' },
  'h2-opts': { host: 'strings', path: 'string' },
  'http-opts': { method: 'string', path: 'strings', headers: 'headers' },
  'grpc-opts': { 'grpc-service-name': 'string', 'grpc-user-agent': 'string',
    'grpc-mode': 'string' },
  'reality-opts': { 'public-key': 'string', 'short-id': 'string',
    'support-x25519mlkem768': 'boolean' },
};

const protocolOptions = {
  ss: { cipher: 'string', password: 'string' },
  anytls: { password: 'string', 'idle-session-check-interval': 'integer',
    'idle-session-timeout': 'integer', 'min-idle-session': 'integer' },
  trojan: { password: 'string', network: 'string', ...transportOptions },
  vmess: { uuid: 'string', cipher: 'string', alterId: 'integer', network: 'string',
    'packet-encoding': 'string', xudp: 'boolean', ...transportOptions },
  vless: { uuid: 'string', flow: 'string', encryption: 'string', network: 'string',
    'packet-encoding': 'string', xudp: 'boolean', ...transportOptions },
};

const pluginOptions = {
  obfs: { mode: 'string', host: 'string' },
  'v2ray-plugin': { mode: 'string', host: 'string', path: 'string',
    tls: 'boolean', 'skip-cert-verify': 'boolean', mux: 'boolean', headers: 'headers' },
};

function typedOptions(input, fields) {
  const result = {};
  for (const [name, validator] of Object.entries(fields)) {
    if (!Object.hasOwn(input, name)) continue;
    const value = input[name];
    if (typeof validator === 'string') {
      if (validators[validator](value)) result[name] = value;
    } else if (isObject(value)) {
      result[name] = typedOptions(value, validator);
    }
  }
  return result;
}

const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const networks = new Set(['tcp', 'ws', 'http', 'h2', 'grpc']);

function readNode(input) {
  if (!isObject(input) || typeof input.type !== 'string' || !Object.hasOwn(protocolOptions, input.type)) return null;
  const { type } = input;
  const label = typeof input.name === 'string' ? input.name.trim() : '';
  const server = hostOf(input.server);
  const port = portOf(input.port);
  if (!label || !server || !port) return null;

  const options = typedOptions(input, { ...sharedOptions, ...protocolOptions[type] });
  if (type === 'ss' && !options.cipher) return null;
  if (type === 'vmess' || type === 'vless') {
    if (!uuid.test(options.uuid ?? '')) return null;
  } else if (!options.password) {
    return null;
  }

  if (input.network !== undefined && (!options.network || !networks.has(options.network))) return null;
  if (type === 'ss' && input.plugin) {
    if (typeof input.plugin !== 'string' || !Object.hasOwn(pluginOptions, input.plugin)) return null;
    options.plugin = input.plugin;
    if (isObject(input['plugin-opts'])) options['plugin-opts'] = typedOptions(input['plugin-opts'], pluginOptions[input.plugin]);
  }
  // Removing a requested dialer would make a chained node behave differently.
  if (input['dialer-proxy']) return null;

  return { label, type, server, port, options };
}

function shortDigest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12);
}

function cleanLabel(label) {
  return Array.from(label.replace(/[^\p{L}\p{N} ._()+-]+/gu, ' ').trim()).slice(0, 44).join('').trim();
}

export function supplierNodeDetails(nodes = []) {
  return nodes.map(({ label, region, proxy }, index) => ({
    name: (typeof label === 'string' && cleanLabel(label)) || `节点 ${index + 1}`,
    region: Object.hasOwn(REGIONS, region) ? region : null,
    protocol: proxy.type,
  }));
}

export function parseSubscription(text, slot) {
  if (!isSupplier(slot)) throw new Error('请选择供应商。');
  let source;
  try {
    const document = parseDocument(text, { strict: true, uniqueKeys: true });
    if (document.errors.length || document.warnings.length) throw new Error('YAML');
    source = document.toJS({ maxAliasCount: 20 });
  } catch {
    // Parser errors may quote a line containing a node password.
    throw new Error('订阅内容不是可解析的 Clash YAML。');
  }
  if (!isObject(source) || !Object.hasOwn(source, 'proxies') || !Array.isArray(source.proxies)) {
    throw new Error('订阅中没有内联节点列表（proxies）。');
  }
  if (source.proxies.length > 1000) throw new Error('节点数量超过单个供应商的导入上限。');

  const nodes = [];
  const identical = new Set();
  const names = new Map();
  for (const input of source.proxies) {
    const node = readNode(input);
    if (!node) continue;
    const { label, type, server, port, options } = node;
    const region = regionOf(label);
    const endpoint = isIP(server) === 6 ? `[${server}]:${port}` : `${server}:${port}`;
    const key = JSON.stringify([region, type, endpoint, options]);
    if (identical.has(key)) continue;
    identical.add(key);

    // Include only public node metadata in the identifier used by Mihomo's API.
    const id = shortDigest([type, endpoint, label]);
    const displayName = cleanLabel(label);
    const name = `${slot}-${region ?? 'ZZ'}-${id}${displayName ? `-${displayName}` : ''}`;
    const count = (names.get(name) ?? 0) + 1;
    names.set(name, count);
    const proxy = { name: count === 1 ? name : `${name}-${count}`, type, server, port, ...options };
    nodes.push({ region, endpoint, proxy, label });
  }

  if (!nodes.length) throw new Error('订阅中没有可导入的节点。支持 SS、AnyTLS、Trojan、VMess 和 VLESS。');
  return { nodes, skipped: source.proxies.length - nodes.length };
}

export function encodeProvider(nodes) {
  return stringify({ proxies: nodes.map(node => node.proxy) }, { lineWidth: 0 });
}

function provider(slot, port, token) {
  return {
    type: 'http',
    url: `http://127.0.0.1:${port}/providers/${slot}.yaml`,
    proxy: 'DIRECT',
    header: { Authorization: [`Bearer ${token}`] },
    // Scheduled checks are scoped by the app. Mihomo can still probe on dial errors.
    'health-check': { enable: false, lazy: true, url: PROBE_URL, 'expected-status': 204 },
  };
}

function fallback(name, members, interval = 0) {
  return {
    name,
    type: 'fallback',
    ...members,
    url: PROBE_URL,
    'expected-status': 204,
    'max-failed-times': 2,
    interval,
    lazy: true,
    'empty-fallback': 'REJECT',
    hidden: true,
  };
}

export function jumpProxy(pairing) {
  return { name: JUMP, type: 'ss', server: pairing.host, port: pairing.port,
    cipher: JUMP_CIPHER, password: pairing.key, udp: true };
}

export function profileRoutingRules(networkMode, personalDirect) {
  const client = networkMode === 'client';
  return routingRules({ agent: client ? JUMP : AGENT_SELECTOR, daily: client ? JUMP : DAILY_SELECTOR,
    downloadInbound: DOWNLOAD_INBOUND, personalDirect: client ? [] : personalDirect });
}

export function buildProfile({ port, state, downloadPort, personalDirect = [] }) {
  const { token, region, routes, suppliers, networkMode, pairing } = state;
  const codes = Object.keys(REGIONS);
  const selected = codes.includes(region) ? region : 'JP';
  const client = networkMode === 'client';
  const profile = {
    mode: 'rule',
    'allow-lan': false,
    'find-process-mode': 'strict',
    listeners: [{ name: DOWNLOAD_INBOUND, type: 'mixed', listen: '127.0.0.1', port: downloadPort }],
    'rule-providers': ruleProviders(port, token),
    'proxy-groups': [{ name: topology(state), type: 'select', proxies: ['REJECT'], hidden: true }],
    rules: profileRoutingRules(networkMode, personalDirect),
  };
  if (client) profile.proxies = [jumpProxy(pairing)];
  else {
    profile['proxy-providers'] = Object.fromEntries(Object.keys(suppliers).map(id => [providerName(id), provider(id, port, token)]));
    profile['proxy-groups'].push(...[[ 'agent', AGENT_SELECTOR ], [ 'daily', DAILY_SELECTOR ]].map(([lane, name]) => ({
      name, type: 'select', proxies: codes.map(code => groupFor(lane, code)), 'default-selected': groupFor(lane, selected),
    })));
    for (const code of codes) for (const lane of LANES) {
      const order = routes[lane];
      profile['proxy-groups'].push(fallback(groupFor(lane, code), order.length
        ? { use: order.map(providerName), filter: `^(${order.join('|')})-${code}-` } : { proxies: ['REJECT'] }));
    }
  }
  return stringify(profile, { lineWidth: 0 });
}

export function buildGatewayProfile({ port, state, peers, outboundInterface }) {
  const { token, region, intervals, routes, suppliers } = state;
  const active = new Set([region, ...state.extraRegions]);
  const groups = [];
  for (const lane of LANES) for (const udp of [false, true]) {
    const names = routes[lane].flatMap(id => (suppliers[id]?.nodes ?? [])
      .filter(node => node.region === region && (!udp || node.proxy.udp === true)).map(node => node.proxy.name));
    groups.push(fallback(groupFor(lane, region) + (udp ? '-UDP' : ''), { proxies: names.length ? names : ['REJECT'] },
      intervals.active * 60));
  }
  const nodes = Object.values(suppliers).flatMap(batch => (batch?.nodes ?? []).filter(node => active.has(node.region)));
  return {
    mode: 'rule', ipv6: true, 'allow-lan': false, 'find-process-mode': 'off', 'log-level': 'warning',
    listeners: peers.map(peer => ({ name: `ClashPro-Share-${peer.id}`, type: 'shadowsocks', listen: '127.0.0.1',
      port: peer.backend, cipher: JUMP_CIPHER, password: peer.key, udp: true })),
    proxies: nodes.map(({ proxy }) => ({ ...proxy, ...(outboundInterface ? { 'interface-name': outboundInterface } : {}) })),
    'proxy-groups': groups,
    'rule-providers': ruleProviders(port, token, ['agent']),
    rules: gatewayRules({ agent: groups[0].name, agentUDP: groups[1].name, daily: groups[2].name, dailyUDP: groups[3].name }),
  };
}
