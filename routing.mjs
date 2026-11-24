import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';
import manifest from './rules-data/manifest.json' with { type: 'json' };

const assetVersion = manifest.revision.slice(0, 12);

export async function readRuleAsset(name) {
  if (!Object.hasOwn(manifest.assets, name)) return null;
  return readFile(new URL(`rules-data/${name}.mrs`, import.meta.url));
}

export async function verifyRuleAssets() {
  await Promise.all(Object.entries(manifest.assets).map(async ([name, { sha256 }]) => {
    const data = await readRuleAsset(name);
    if (!data.length || createHash('sha256').update(data).digest('hex') !== sha256) {
      throw new Error(`MRS 文件校验失败：${name}`);
    }
  }));
}

export function ruleProviders(port, token) {
  return Object.fromEntries(Object.entries(manifest.assets).map(([name, { behavior }]) => [
    `clash-pro-${name}`, {
      type: 'http', behavior, format: 'mrs', proxy: 'DIRECT',
      url: `http://127.0.0.1:${port}/rules/${name}.mrs`,
      path: `./provider/rule-set/clash-pro-${assetVersion}/${name}.mrs`,
      header: { Authorization: [`Bearer ${token}`] },
    },
  ]));
}

function isPersonalDirectRule(rule) {
  if (typeof rule !== 'string') return false;
  const [kind, value, target, option, extra] = rule.split(',');
  if (!value || target !== 'DIRECT' || extra !== undefined) return false;
  if (kind === 'DOMAIN-SUFFIX' || kind === 'DOMAIN') {
    return option === undefined && value.length <= 253 &&
      value.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
  }
  if (kind !== 'IP-CIDR' && kind !== 'IP-CIDR6') return false;
  const [address, bits, tail] = value.split('/');
  return (option === undefined || option === 'no-resolve') && tail === undefined &&
    isIP(address) === (kind === 'IP-CIDR' ? 4 : 6) && /^\d{1,3}$/.test(bits) &&
    Number(bits) <= (kind === 'IP-CIDR' ? 32 : 128);
}

export async function readPersonalDirect(directory) {
  try {
    const rules = JSON.parse(await readFile(join(directory, 'personal-direct.json'), 'utf8'));
    if (!Array.isArray(rules) || !rules.every(isPersonalDirectRule)) throw new Error();
    return [...new Set(rules)].map(rule => /^IP-CIDR6?,[^,]+,DIRECT$/.test(rule) ? `${rule},no-resolve` : rule);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw Object.assign(new Error('本机直连规则无效，请检查 personal-direct.json。'), { code: 'PERSONAL_RULES' });
  }
}

const suffixes = (domains) => domains.map(domain => `DOMAIN-SUFFIX,${domain}`);
const exact = (domains) => domains.map(domain => `DOMAIN,${domain}`);
const domainSet = (name) => `RULE-SET,clash-pro-domain-${name}`;
const ipSet = (name) => `RULE-SET,clash-pro-ip-${name}`;

const localNetworks = [
  '127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '169.254.0.0/16',
];

const agentHosts = [
  ...['openai', 'anthropic', 'cursor'].map(domainSet),
  ...suffixes(['openai.com', 'chatgpt.com', 'oaistatic.com', 'oaiusercontent.com',
    'anthropic.com', 'claude.ai', 'cursor.com', 'cursor.sh', 'githubcopilot.com']),
  ...exact(['gemini.google.com', 'aistudio.google.com', 'generativelanguage.googleapis.com',
    'copilot.microsoft.com', 'copilot-proxy.githubusercontent.com']),
];

const agentProcesses = [
  'PROCESS-NAME,codex',
  'PROCESS-NAME,claude',
  'PROCESS-PATH-REGEX,/(?i:ChatGPT|Codex|Claude|Cursor)\\.app/Contents/',
];

const bulkDirect = [
  // OS and browser software updates.
  ...exact(['swcdn.apple.com', 'swdownload.apple.com', 'swdist.apple.com', 'swscan.apple.com',
    'swquery.apple.com', 'gdmf.apple.com', 'mesu.apple.com', 'appldnld.apple.com',
    'updates.cdn-apple.com', 'updates-http.cdn-apple.com', 'update.googleapis.com', 'dl.google.com',
    'edgedl.me.gvt1.com', 'update.microsoft.com', 'download.microsoft.com']),
  ...suffixes(['windowsupdate.com', 'delivery.mp.microsoft.com']),
  // Package registries, container registries, and dedicated GitHub assets.
  ...exact(['registry.npmjs.org', 'registry.yarnpkg.com', 'pypi.org', 'files.pythonhosted.org',
    'registry-1.docker.io', 'auth.docker.io', 'registry.hub.docker.com', 'production.cloudflare.docker.com',
    'registry.k8s.io', 'pkg-containers.githubusercontent.com',
    'release-assets.githubusercontent.com', 'objects.githubusercontent.com',
    'github-releases.githubusercontent.com', 'codeload.github.com']),
  ...suffixes(['ghcr.io', 'quay.io', 'mcr.microsoft.com']),
];

const dailyHosts = [
  ...['youtube', 'netflix', 'disney', 'spotify', 'tiktok', 'google', 'github', 'gitlab', 'wikimedia',
    'telegram', 'discord', 'whatsapp', 'reddit', 'twitter', 'facebook', 'instagram'].map(domainSet),
  ...suffixes(['stackoverflow.com', 'stackexchange.com', 'x.com']),
];

function forPolicy(matches, policy) {
  // Mihomo can fall through a rule whose selected proxy does not handle UDP.
  return matches.flatMap(match => [`${match},${policy}`, `${match},REJECT`]);
}

export function routingRules({ agent, daily, downloadInbound, personalDirect }) {
  const downloadMatches = [`IN-NAME,${downloadInbound}`, 'PROCESS-NAME,aria2c'];
  const directChinaIP = (match, option = '') => `AND,((${match}),(${ipSet('cn')}${option})),DIRECT`;
  return [
    'DOMAIN,localhost,DIRECT',
    ...suffixes(['local', 'ts.net']).map(match => `${match},DIRECT`),
    ...localNetworks.map(cidr => `IP-CIDR,${cidr},DIRECT,no-resolve`),
    ...['::1/128', 'fc00::/7', 'fe80::/10'].map(cidr => `IP-CIDR6,${cidr},DIRECT,no-resolve`),
    `${domainSet('private')},DIRECT`,
    ...personalDirect,
    'DOMAIN-SUFFIX,cn,DIRECT',
    ...['cn', 'steam-cn'].map(name => `${domainSet(name)},DIRECT`),
    ...downloadMatches.map(match => directChinaIP(match)),
    ...forPolicy(downloadMatches, daily),
    ...forPolicy(agentHosts, agent),
    ...agentProcesses.map(match => directChinaIP(match, ',no-resolve')),
    ...forPolicy(agentProcesses, agent),
    ...bulkDirect.map(match => `${match},DIRECT`),
    ...forPolicy(dailyHosts, daily),
    `${ipSet('telegram')},${daily},no-resolve`,
    `${ipSet('telegram')},REJECT,no-resolve`,
    ...forPolicy([domainSet('gfw')], daily),
    `${ipSet('cn')},DIRECT,no-resolve`,
    'MATCH,DIRECT',
  ];
}

export function gatewayRules({ agent, daily, agentUDP, dailyUDP }) {
  const udp = (match) => `AND,((NETWORK,udp),(${match}))`;
  return [
    `${domainSet('private')},REJECT`,
    ...suffixes(['localhost', 'local', 'ts.net']).map(match => `${match},REJECT`),
    ...[...localNetworks, '0.0.0.0/8', '224.0.0.0/3'].map(cidr => `IP-CIDR,${cidr},REJECT,no-resolve`),
    ...['::/128', '::1/128', 'fc00::/7', 'fe80::/10', 'ff00::/8'].map(cidr => `IP-CIDR6,${cidr},REJECT,no-resolve`),
    ...forPolicy(agentHosts.map(udp), agentUDP),
    ...forPolicy(agentHosts, agent),
    ...forPolicy(['NETWORK,udp'], dailyUDP),
    ...forPolicy(['NETWORK,tcp'], daily),
    'MATCH,REJECT',
  ];
}
