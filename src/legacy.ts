/**
 * legacy.ts — 旧版兼容层（可选）。
 *
 * 仅在 WORKBUDDY_USE_LEGACY_APP=1 时启用：读取并解密本机 WorkBuddy App 的
 * 登录态文件，复用 App 的 Electron binding 取 at-rest 主密钥。
 * 默认不加载本模块，因此插件可以在没装 WorkBuddy 的机器上独立运行。
 *
 * 逆向细节见 docs/WORKBUDDY_REVERSE.md 第 3 节。
 */

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { settings } from './config';
import { decodeJwtPayload, jwtExpiresAt } from './jwt';
import type { WorkBuddyAuthState } from './auth';

const FRAMING_FIELD = 2;
const MAGIC_FIELD = 'WBEV1';
const SUITE_AES_256_GCM = 1;

function u32(n: number): Buffer {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32BE(n);
  return b;
}

function lp(s: string): Buffer {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([u32(b.length), b]);
}

function buildAad(keyId: string, suite: number): Buffer {
  return Buffer.concat([
    Buffer.from('WB-AAD\0', 'ascii'),
    Buffer.from([1]),
    lp(MAGIC_FIELD),
    lp('sym-v1'),
    u32(suite),
    lp(keyId),
    Buffer.from([FRAMING_FIELD]),
    Buffer.from([0]),
    Buffer.from([0]),
  ]);
}

let atRestKey: Buffer | null = null;

/** 用 WorkBuddy 自带的 Electron 以 NODE 模式执行自定义 binding 取 at-rest 密钥 */
function getAtRestKey(): Buffer {
  if (atRestKey) return atRestKey;
  const script = "process.stdout.write(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet())";
  const r = spawnSync(settings.appPath, ['-e', script], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  });
  if (r.error) {
    throw new Error(`读取 at-rest 密钥失败（WorkBuddy 未安装或路径不对）: ${r.error.message}；可用 WORKBUDDY_APP_PATH 指定`);
  }
  if (r.status !== 0) {
    throw new Error(`读取 at-rest 密钥失败: exit=${r.status} ${(r.stderr || '').trim().slice(0, 300)}`);
  }
  let payload: any;
  try {
    payload = JSON.parse(r.stdout);
  } catch {
    throw new Error('读取 at-rest 密钥失败: binding 输出不是 JSON（WorkBuddy 版本可能不兼容）');
  }
  const secret = payload?.atRestSecretKey;
  if (typeof secret !== 'string' || !secret) throw new Error('读取 at-rest 密钥失败: atRestSecretKey 缺失');
  atRestKey = crypto.createHash('sha256').update(secret, 'utf8').digest();
  return atRestKey;
}

interface FieldEnvelope {
  suite: number;
  keyId: string;
  nonce: string;
  authTag: string;
  ciphertext: string;
}

function unwrapEnvelope(wrapper: any): FieldEnvelope {
  if (!wrapper || typeof wrapper !== 'object' || typeof wrapper.envelope !== 'string') {
    throw new Error('auth 字段不是 $wbEncrypted 信封格式');
  }
  return JSON.parse(Buffer.from(wrapper.envelope, 'base64').toString('utf8'));
}

function openField(key: Buffer, wrapper: any): string {
  const env = unwrapEnvelope(wrapper);
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.nonce, 'base64'), { authTagLength: 16 });
  d.setAAD(buildAad(env.keyId, env.suite));
  d.setAuthTag(Buffer.from(env.authTag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(env.ciphertext, 'base64')), d.final()]).toString('utf8');
}

/** 把新 token 重新封装并原子写回 App 登录态文件（复用原 keyId） */
function sealField(key: Buffer, keyId: string, plaintext: string): any {
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  c.setAAD(buildAad(keyId, SUITE_AES_256_GCM));
  const ciphertext = Buffer.concat([c.update(Buffer.from(plaintext, 'utf8')), c.final()]);
  const envelope: FieldEnvelope = {
    suite: SUITE_AES_256_GCM,
    keyId,
    nonce: nonce.toString('base64'),
    authTag: c.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
  return { $wbEncrypted: 1, envelope: Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64') };
}

export function readLegacyAppAuth(): WorkBuddyAuthState | null {
  try {
    if (!fs.existsSync(settings.authPath)) return null;
    const raw = JSON.parse(fs.readFileSync(settings.authPath, 'utf8'));
    if (!raw?.auth?.accessToken || !raw?.auth?.refreshToken) return null;
    const key = getAtRestKey();
    const accessToken = openField(key, raw.auth.accessToken);
    const refreshToken = openField(key, raw.auth.refreshToken);
    if (!accessToken || !refreshToken) return null;
    return {
      accessToken,
      refreshToken,
      uid: raw.account?.uid ?? decodeJwtPayload(accessToken).sub ?? '',
      domain: raw.auth.domain || settings.domain,
      expiresAt: Number(raw.auth.expiresAt) || jwtExpiresAt(accessToken),
      refreshExpiresAt: Number(raw.auth.refreshExpiresAt) || undefined,
      raw,
      source: 'file',
    };
  } catch (e: any) {
    console.warn(`[workbuddy][legacy] 读取 App 登录态失败: ${e.message}`);
    return null;
  }
}

/** 可选：把续期后的 token 写回 App 登录态文件，让 App 与本插件共用登录态 */
export function writeLegacyAppAuth(base: WorkBuddyAuthState, p: { accessToken: string; refreshToken?: string }): void {
  if (!base.raw || base.source !== 'file') return;
  try {
    const key = getAtRestKey();
    const raw = JSON.parse(JSON.stringify(base.raw));
    const keyId = unwrapEnvelope(raw.auth.accessToken).keyId;
    raw.auth.accessToken = sealField(key, keyId, p.accessToken);
    if (p.refreshToken) raw.auth.refreshToken = sealField(key, keyId, p.refreshToken);
    raw.auth.lastRefreshTime = Date.now();
    const tmp = `${settings.authPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(raw, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, settings.authPath);
    console.log('[workbuddy][legacy] 新 token 已写回 App 登录态文件');
  } catch (e: any) {
    console.warn(`[workbuddy][legacy] 写回 App 登录态失败（不影响转发）: ${e.message}`);
  }
}
