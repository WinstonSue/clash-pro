import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { createGunzip } from 'node:zlib';

const privateNetworks = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['224.0.0.0', 4], ['240.0.0.0', 4]]) {
  privateNetworks.addSubnet(address, prefix, 'ipv4');
}
for (const [address, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) {
  privateNetworks.addSubnet(address, prefix, 'ipv6');
}

export function parseLink(link, base) {
  let url;
  try { url = new URL(link, base); } catch { throw new Error('请输入有效的 HTTPS 订阅链接。'); }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) {
    throw new Error('请输入有效的 HTTPS 订阅链接。');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  const family = isIP(hostname);
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') ||
      (family && privateNetworks.check(hostname, `ipv${family}`))) {
    throw new Error('订阅链接必须指向供应商的公网地址。');
  }
  return url;
}

function readSubscription(url, signal) {
  return new Promise((resolve, reject) => {
    const req = request(url, {
      signal,
      headers: { 'User-Agent': 'clash-verge/2.5.10', Accept: '*/*', 'Accept-Encoding': 'gzip, identity' },
      lookup(hostname, options, callback) {
        lookup(hostname, { all: true, family: options.family }).then((records) => {
          const publicRecords = records.filter(({ address, family }) => !privateNetworks.check(address, `ipv${family}`));
          if (!publicRecords.length || records.length !== publicRecords.length) {
            callback(new Error('订阅域名没有可用的公网地址。'));
            return;
          }
          if (options.all) callback(null, publicRecords);
          else callback(null, publicRecords[0].address, publicRecords[0].family);
        }, callback);
      },
    }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.destroy();
        resolve({ redirect: response.headers.location });
        return;
      }
      if (response.statusCode !== 200) {
        response.destroy();
        reject(new Error(`供应商返回 HTTP ${response.statusCode}。请获取新的链接。`));
        return;
      }
      response.on('error', reject);
      const stream = response.headers['content-encoding'] === 'gzip' ? response.pipe(createGunzip()) : response;
      const chunks = [];
      let size = 0;
      stream.on('error', reject);
      stream.on('data', (chunk) => {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) req.destroy(new Error('订阅文件超过 4 MB。'));
        else chunks.push(chunk);
      });
      stream.on('end', () => resolve({ text: Buffer.concat(chunks).toString('utf8') }));
      stream.on('close', () => { if (!stream.readableEnded) reject(new Error('订阅传输中断。')); });
    });
    req.on('error', reject);
    req.end();
  });
}

export async function fetchSubscription(link) {
  let url = parseLink(link);
  const signal = AbortSignal.timeout(20_000);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    let response;
    try { response = await readSubscription(url, signal); }
    catch (error) {
      if (/^(供应商返回 HTTP |订阅文件超过 |订阅域名没有|订阅传输中断)/.test(error.message)) throw error;
      throw new Error(signal.aborted ? '获取订阅超时。' : '无法连接供应商。请检查连接或获取新链接。');
    }
    if (response.redirect === undefined) return response.text;
    url = parseLink(response.redirect, url);
  }
  throw new Error('供应商链接重定向次数过多。');
}
