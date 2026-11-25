import { createHash, randomUUID } from 'node:crypto';
import { link, open, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { domainToASCII } from 'node:url';
import defaults from './rules-data/proxy-allowlist-default.json' with { type: 'json' };
import { LANES } from './suppliers.mjs';

export const ALLOWLIST_LIMIT = 256 * 1024;
const ruleSetPrefix = 'RULE-SET,';
export const projectAllowlistURL = 'https://raw.githubusercontent.com/WinstonSue/clash-pro/main/rules-data/proxy-allowlist-default.json';
export const allowlistRuleSets = [...new Set(Object.values(defaults).flat()
  .filter(rule => rule.startsWith(ruleSetPrefix)).map(rule => rule.slice(ruleSetPrefix.length)))].sort();
const fileName = 'proxy-allowlist.json';
const missingRevision = 'missing';
const serialize = rules => `${JSON.stringify(rules, null, 2)}\n`;
const hash = raw => createHash('sha256').update(raw).digest('hex');

function invalid(message) {
  return Object.assign(new Error(message), { code: 'ALLOWLIST_INVALID' });
}

function normalizeRule(rule, lane, index) {
  const [kind, raw, extra] = typeof rule === 'string' ? rule.trim().split(',') : [];
  if (raw && extra === undefined) {
    const value = raw.trim().toLowerCase();
    if (kind === 'RULE-SET' && allowlistRuleSets.includes(value) &&
        (value !== 'ip-telegram' || lane === 'daily')) return `${kind},${value}`;
    if ((kind === 'DOMAIN' || kind === 'DOMAIN-SUFFIX') && /^[\p{L}\p{N}\p{M}.-]+$/u.test(value)) {
      const domain = domainToASCII(value);
      if (domain && domain.length <= 253 &&
          domain.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
        return `${kind},${domain}`;
      }
    }
  }
  throw invalid(`${lane === 'agent' ? 'Agent' : '日常'}白名单第 ${index + 1} 条规则无效。`);
}

export function validateAllowlist(rules) {
  if (!rules || typeof rules !== 'object' || Object.keys(rules).length !== LANES.length ||
      !LANES.every(lane => Object.hasOwn(rules, lane) && Array.isArray(rules[lane]))) {
    throw invalid('白名单须包含 agent 和 daily 两个规则数组。');
  }
  const normalized = Object.fromEntries(LANES.map(lane =>
    [lane, [...new Set(rules[lane].map((rule, index) => normalizeRule(rule, lane, index)))]]));
  if (Buffer.byteLength(serialize(normalized)) > ALLOWLIST_LIMIT) throw invalid('白名单文件超过 256 KB。');
  return normalized;
}

export function parseAllowlist(raw) {
  if (Buffer.byteLength(raw) > ALLOWLIST_LIMIT) throw invalid('白名单文件超过 256 KB。');
  let rules;
  try { rules = JSON.parse(raw); }
  catch { throw invalid('白名单文件不是有效的 JSON。'); }
  return validateAllowlist(rules);
}

function compile(rules) {
  return Object.fromEntries(LANES.map(lane => [lane, rules[lane].map(rule => {
    if (!rule.startsWith(ruleSetPrefix)) return rule;
    // Classical providers accept RULE-SET inside a logical rule.
    const name = rule.slice(ruleSetPrefix.length);
    const option = name === 'ip-telegram' ? ',no-resolve' : '';
    return `AND,((RULE-SET,clash-pro-${name}${option}))`;
  }).join('\n') + (rules[lane].length ? '\n' : '# Empty allowlist\n')]));
}

async function readRuleFile(path) {
  try {
    const file = await open(path, 'r');
    try {
      const stat = await file.stat();
      if (!stat.isFile()) return { revision: null, error: '无法读取白名单文件。' };
      if (stat.size > ALLOWLIST_LIMIT) {
        return { revision: `oversize-${stat.ino}-${stat.size}-${stat.mtimeMs}`, error: '白名单文件超过 256 KB。' };
      }
      const buffer = Buffer.allocUnsafe(ALLOWLIST_LIMIT + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
        if (!bytesRead) break;
        size += bytesRead;
      }
      const raw = buffer.subarray(0, size);
      return { revision: hash(raw), raw: raw.toString('utf8') };
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error.code === 'ENOENT') return { revision: missingRevision, error: `未找到 ${fileName}。` };
    return { revision: null, error: `无法读取 ${fileName}。` };
  }
}

async function writeAtomic(file, text, commit = rename) {
  const pending = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(pending, text, { flag: 'wx', mode: 0o600 });
    await commit(pending, file);
  } finally {
    await rm(pending, { force: true });
  }
}

export async function openAllowlist(directory) {
  const file = join(directory, fileName);
  const backup = join(directory, 'proxy-allowlist.last-good.json');
  let rules = validateAllowlist(defaults);
  let persisted = false;
  const saved = await readRuleFile(backup);
  if (!saved.error) {
    try {
      rules = parseAllowlist(saved.raw);
      persisted = true;
    } catch { /* A malformed snapshot cannot replace the bundled rules. */ }
  } else if (saved.revision === missingRevision && (await readRuleFile(file)).revision === missingRevision) {
    try { await writeAtomic(file, serialize(rules), link); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  let published = serialize(rules);
  let feeds = compile(rules);
  let checkedRevision, revision, error;
  let pending = Promise.resolve();
  function enqueue(action) {
    const next = pending.then(action);
    pending = next.catch(() => {});
    return next;
  }

  async function refresh() {
    const source = await readRuleFile(file);
    revision = source.revision;
    if (revision !== null && revision === checkedRevision) return;
    checkedRevision = revision;
    let candidate;
    try {
      if (source.error) throw invalid(source.error);
      candidate = parseAllowlist(source.raw);
    } catch (issue) {
      error = issue.message;
      return;
    }
    const text = serialize(candidate);
    if (!persisted || text !== published) {
      try { await writeAtomic(backup, text); }
      catch {
        checkedRevision = undefined;
        error = '无法保存有效白名单的备份，请检查数据目录。';
        return;
      }
      persisted = true;
      published = text;
      rules = candidate;
      feeds = compile(candidate);
    }
    error = null;
  }

  const snapshot = () => ({ revision, error, rules });
  await refresh();
  return {
    file,
    snapshot,
    status: () => ({ error }),
    feed: lane => feeds[lane],
    read: () => enqueue(async () => {
      await refresh();
      return snapshot();
    }),
    refresh: () => enqueue(refresh),
    replace(expectedRevision, input) {
      return enqueue(async () => {
        const text = serialize(validateAllowlist(input));
        const conflict = () => Object.assign(
          new Error('白名单文件已被修改。请读取当前版本后再保存。'), { code: 'ALLOWLIST_CONFLICT' });
        await writeAtomic(file, text, async (temporary, target) => {
          const current = await readRuleFile(target);
          if (current.revision === null || expectedRevision !== current.revision) throw conflict();
          await rename(temporary, target);
        });
        await refresh();
        if (revision !== hash(text)) throw conflict();
        if (error) throw new Error(error);
        return snapshot();
      });
    },
  };
}
