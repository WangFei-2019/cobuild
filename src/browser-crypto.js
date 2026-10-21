// Pages demo only. The production server continues to use node:crypto.
// SHA-256 keeps milestone fingerprints and replan IDs identical to the server.
import {sha256} from '@noble/hashes/sha2.js';
import {bytesToHex} from '@noble/hashes/utils.js';

export function randomUUID() {
  const crypto = globalThis.crypto;
  if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
  if (typeof crypto?.getRandomValues !== 'function') throw new Error('当前浏览器不支持安全随机数，请使用 HTTPS 打开演示');
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytesToHex(bytes);
  return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
}

export function createHash(algorithm) {
  if (algorithm !== 'sha256') throw new Error('浏览器演示只支持 SHA-256');
  const hash = sha256.create();
  let finished = false;
  const api = {
    update(value, encoding = 'utf8') {
      if (finished) throw new Error('摘要已结束');
      if (encoding !== 'utf8' && encoding !== 'utf-8') throw new Error('浏览器演示只支持 UTF-8 输入');
      const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
      if (!(bytes instanceof Uint8Array)) throw new TypeError('摘要输入需要字符串或 Uint8Array');
      hash.update(bytes);
      return api;
    },
    digest(encoding) {
      if (finished) throw new Error('摘要已结束');
      if (encoding !== undefined && encoding !== 'hex') throw new Error('浏览器演示只支持十六进制摘要');
      finished = true;
      const result = hash.digest();
      return encoding === 'hex' ? bytesToHex(result) : result;
    },
  };
  return api;
}
