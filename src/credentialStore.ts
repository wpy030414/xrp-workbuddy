/**
 * credentialStore.ts — 自包含凭证的静态加密落盘（不依赖 WorkBuddy App）。
 *
 * 三种存储形态（按可用性自动选择，格式前缀自描述）：
 *   dpapi:v1:<b64>   Windows CurrentUser DPAPI（凭证只在本机本用户可解）
 *   aes:v1:<iv>:<tag>:<ct>  WORKBUDDY_AUTH_SECRET 提供的 passphrase 派生 AES-256-GCM
 *   plain:v1:<b64>   兜底明文（仅非 Windows 且未配密钥时；文件权限 0600 并告警）
 *
 * 明文一律不进命令行：与 PowerShell 交互走 stdin，避免进程列表泄露。
 */

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type StoreMode = 'auto' | 'dpapi' | 'aes' | 'plain';

const DPAPI_PREFIX = 'dpapi:v1:';
const AES_PREFIX = 'aes:v1:';
const PLAIN_PREFIX = 'plain:v1:';

function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** 经 stdin 传递数据，调用 PowerShell 做 DPAPI Protect / Unprotect */
function runDpapi(action: 'Protect' | 'Unprotect', payloadB64: string): string | null {
  const script =
    `Add-Type -AssemblyName System.Security | Out-Null;` +
    `$b64 = [Console]::In.ReadToEnd().Trim();` +
    `$bytes = [Convert]::FromBase64String($b64);` +
    `$out = [Security.Cryptography.ProtectedData]::${action}($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser);` +
    `[Console]::Out.Write([Convert]::ToBase64String($out))`;
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', timeout: 20_000, windowsHide: true, input: payloadB64 },
  );
  if (r.error || r.status !== 0) {
    if (process.env.WORKBUDDY_DEBUG) {
      console.warn(`[store] DPAPI ${action} 失败: ${r.error?.message || (r.stderr || '').trim().slice(0, 200)}`);
    }
    return null;
  }
  const out = (r.stdout || '').trim();
  return out || null;
}

function aesKey(secret: string): Buffer {
  return crypto.createHash('sha256').update(secret, 'utf8').digest();
}

function aesEncrypt(secret: string, plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', aesKey(secret), iv, { authTagLength: 16 });
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return `${AES_PREFIX}${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}

function aesDecrypt(secret: string, blob: string): string {
  const [ivB64, tagB64, ctB64] = blob.slice(AES_PREFIX.length).split(':');
  if (!ivB64 || !tagB64 || !ctB64) throw new Error('AES 凭证信封格式不合法');
  const d = crypto.createDecipheriv('aes-256-gcm', aesKey(secret), Buffer.from(ivB64, 'base64'), { authTagLength: 16 });
  d.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ctB64, 'base64')), d.final()]).toString('utf8');
}

export interface StoreOptions {
  file: string;
  mode: StoreMode;
  /** aes 模式用的 passphrase；缺省时不启用 AES */
  secret?: string;
}

export interface SealedRecord<T> {
  blob: string;
  kind: 'dpapi' | 'aes' | 'plain';
}

/** 选定实际加密形态：显式 mode 优先，其次 AES 密钥，其次 DPAPI，最后明文 */
export function resolveKind(opts: StoreOptions): 'dpapi' | 'aes' | 'plain' {
  if (opts.mode === 'dpapi') return 'dpapi';
  if (opts.mode === 'aes') return 'aes';
  if (opts.mode === 'plain') return 'plain';
  if (opts.secret) return 'aes';
  if (process.platform === 'win32') return 'dpapi';
  return 'plain';
}

export function seal<T>(opts: StoreOptions, value: T): SealedRecord<T> {
  const json = JSON.stringify(value);
  const kind = resolveKind(opts);
  if (kind === 'aes') {
    if (!opts.secret) throw new Error('凭证存储要求 AES，但未提供 WORKBUDDY_AUTH_SECRET');
    return { blob: aesEncrypt(opts.secret, json), kind };
  }
  if (kind === 'dpapi') {
    const b64 = runDpapi('Protect', Buffer.from(json, 'utf8').toString('base64'));
    if (b64) return { blob: `${DPAPI_PREFIX}${b64}`, kind };
    if (opts.mode === 'dpapi') throw new Error('DPAPI 加密失败（powershell.exe 不可用？）');
    console.warn('[store] DPAPI 不可用，降级为明文存储（文件权限 0600）');
  }
  return { blob: `${PLAIN_PREFIX}${Buffer.from(json, 'utf8').toString('base64')}`, kind: 'plain' };
}

export function open<T>(opts: StoreOptions, blob: string): T {
  if (blob.startsWith(DPAPI_PREFIX)) {
    const out = runDpapi('Unprotect', blob.slice(DPAPI_PREFIX.length));
    if (!out) throw new Error('DPAPI 解密失败：凭证可能不是本机本用户写入的');
    return JSON.parse(Buffer.from(out, 'base64').toString('utf8'));
  }
  if (blob.startsWith(AES_PREFIX)) {
    if (!opts.secret) throw new Error('凭证是 AES 加密的，请设置 WORKBUDDY_AUTH_SECRET');
    return JSON.parse(aesDecrypt(opts.secret, blob));
  }
  if (blob.startsWith(PLAIN_PREFIX)) {
    return JSON.parse(Buffer.from(blob.slice(PLAIN_PREFIX.length), 'base64').toString('utf8'));
  }
  // 兼容：直接落盘的裸 JSON
  return JSON.parse(blob);
}

/** 原子写：临时文件 + rename，权限收紧到 0600 */
export function writeBlob(file: string, blob: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, blob, { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    /* Windows 上 chmod 语义有限，忽略 */
  }
  fs.renameSync(tmp, file);
}

export function readBlob(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e: any) {
    if (e?.code === 'ENOENT') return null;
    throw e;
  }
}

export function describeKind(blob: string | null): string {
  if (!blob) return 'none';
  if (blob.startsWith(DPAPI_PREFIX)) return 'dpapi';
  if (blob.startsWith(AES_PREFIX)) return 'aes';
  if (blob.startsWith(PLAIN_PREFIX)) return 'plain';
  return 'raw-json';
}
