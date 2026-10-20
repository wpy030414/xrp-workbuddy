/**
 * workbuddy/auth.ts — WorkBuddy 本机登录态读取、解密、刷新与写回。
 *
 * 逆向结论（详见 docs/WORKBUDDY_REVERSE.md）：
 * - 登录态文件：%LOCALAPPDATA%/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info
 * - accessToken / refreshToken 是 AES-256-GCM「字段级」密文信封：
 *     { $wbEncrypted: 1, envelope: base64(JSON{suite,keyId,nonce,authTag,ciphertext}) }
 *   AAD = "WB-AAD\0" | ver=1 | "WBEV1" | "sym-v1" | suite | keyId | framing(=2) | 0 | 0
 * - 密钥：WorkBuddy 自定义 binding electron_browser_workbuddy_storage.loggerGet()
 *   返回 { atRestSecretKey }，sha256(secret) 即 AES-256 key（keyId 沿用原信封）
 * - 刷新：POST /v2/plugin/auth/token/refresh，头 X-Refresh-Token + X-Auth-Refresh-Source: plugin，
 *   响应 data.{accessToken,refreshToken,expiresIn,refreshExpiresIn,...}
 * - 写回：App 自身对 auth 文件做目录监听（handleExternalChange → restore），因此插件刷新后
 *   原子写回该文件，WorkBuddy 会同步新登录态，避免 refresh token 轮换互踩。
 */

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { settings } from './config';

export interface WorkBuddyAuthState {
  accessToken: string;
  refreshToken: string;
  uid: string;
  domain: string;
  /** access token 过期时间（ms epoch） */
  expiresAt: number;
  /** refresh token 过期时间（ms epoch，可能未知） */
  refreshExpiresAt?: number;
  /** auth 文件原始 JSON（用于写回；env 灾备时为 undefined） */
  raw?: any;
  source: 'file' | 'env' | 'cache';
}

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

/** 读取 at-rest 主密钥（缓存）：用 WorkBuddy 自带的 Electron 以 NODE 模式执行 binding */
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
  if (typeof secret !== 'string' || !secret) {
    throw new Error('读取 at-rest 密钥失败: atRestSecretKey 缺失');
  }
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

/** 解 JWT payload（不校验签名，只用于取 exp/sub） */
export function decodeJwtPayload(token: string): any {
  try {
    const part = token.split('.')[1] || '';
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return {};
  }
}

function jwtExpiresAt(token: string): number {
  const exp = Number(decodeJwtPayload(token).exp);
  return Number.isFinite(exp) && exp > 0 ? exp * 1000 : 0;
}

function readAuthFile(): WorkBuddyAuthState {
  const raw = JSON.parse(fs.readFileSync(settings.authPath, 'utf8'));
  if (!raw?.auth?.accessToken || !raw?.auth?.refreshToken) {
    throw new Error('登录态文件缺少 auth.accessToken / auth.refreshToken');
  }
  const key = getAtRestKey();
  const accessToken = openField(key, raw.auth.accessToken);
  const refreshToken = openField(key, raw.auth.refreshToken);
  if (!accessToken || !refreshToken) throw new Error('登录态 token 解密为空');
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
}

function loadFromEnv(): WorkBuddyAuthState | null {
  if (!settings.accessTokenEnv) return null;
  return {
    accessToken: settings.accessTokenEnv,
    refreshToken: settings.refreshTokenEnv,
    uid: settings.userIdEnv || decodeJwtPayload(settings.accessTokenEnv).sub || '',
    domain: settings.domain,
    expiresAt: jwtExpiresAt(settings.accessTokenEnv),
    source: 'env',
  };
}

/** 尝试读取文件；失败返回 null（由上层决定降级） */
function tryReadAuthFile(): WorkBuddyAuthState | null {
  try {
    if (!fs.existsSync(settings.authPath)) return null;
    return readAuthFile();
  } catch (e: any) {
    console.warn(`[workbuddy] 读取登录态失败: ${e.message}`);
    return null;
  }
}

interface RefreshPayload {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  refreshExpiresAt?: number;
  expiresIn?: number;
  refreshExpiresIn?: number;
  rawData: any;
}

function num(v: any): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

async function requestRefreshToken(state: WorkBuddyAuthState): Promise<RefreshPayload> {
  if (!state.refreshToken) {
    throw new Error('没有 refresh token（请打开 WorkBuddy 重新登录）');
  }
  const url = `${settings.baseUrl}${settings.refreshPath}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-Refresh-Token': state.refreshToken,
    'X-Auth-Refresh-Source': 'plugin',
    'X-Domain': state.domain,
    'X-Product': settings.product,
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': settings.ideVersion,
    'X-Private-Data': 'true',
    'User-Agent': `WorkBuddy/${settings.ideVersion}`,
    'x-requested-with': 'XMLHttpRequest',
  };
  if (state.uid) headers['X-User-Id'] = state.uid;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: '{}',
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`刷新令牌失败: HTTP ${res.status} 非 JSON 响应`);
  }
  if (!res.ok || (typeof json.code === 'number' && json.code !== 0)) {
    throw new Error(`刷新令牌失败: HTTP ${res.status} code=${json.code ?? '?'} ${json.msg ?? ''}`.trim());
  }
  const data = json.data?.data ?? json.data;
  const accessToken = data?.accessToken ?? data?.access_token;
  if (typeof accessToken !== 'string' || !accessToken) {
    throw new Error('刷新令牌响应缺少 accessToken');
  }
  return {
    accessToken,
    refreshToken: typeof (data.refreshToken ?? data.refresh_token) === 'string' ? (data.refreshToken ?? data.refresh_token) : undefined,
    expiresAt: num(data.expiresAt),
    refreshExpiresAt: num(data.refreshExpiresAt),
    expiresIn: num(data.expiresIn),
    refreshExpiresIn: num(data.refreshExpiresIn),
    rawData: data,
  };
}

/** 把新 token 原子写回 auth 文件（App 会监听并同步） */
function persistAuthFile(base: WorkBuddyAuthState, p: RefreshPayload): void {
  if (!base.raw || base.source !== 'file') return;
  try {
    const key = getAtRestKey();
    const raw = JSON.parse(JSON.stringify(base.raw));
    const keyId = unwrapEnvelope(raw.auth.accessToken).keyId;
    const now = Date.now();

    raw.auth.accessToken = sealField(key, keyId, p.accessToken);
    if (p.refreshToken) raw.auth.refreshToken = sealField(key, keyId, p.refreshToken);

    const expiresAt = p.expiresAt ?? (p.expiresIn ? now + p.expiresIn * 1000 : undefined);
    const refreshExpiresAt = p.refreshExpiresAt ?? (p.refreshExpiresIn ? now + p.refreshExpiresIn * 1000 : undefined);
    if (p.expiresIn !== undefined) raw.auth.expiresIn = p.expiresIn;
    if (p.refreshExpiresIn !== undefined) raw.auth.refreshExpiresIn = p.refreshExpiresIn;
    if (expiresAt !== undefined) raw.auth.expiresAt = expiresAt;
    if (refreshExpiresAt !== undefined) raw.auth.refreshExpiresAt = refreshExpiresAt;
    raw.auth.lastRefreshTime = now;
    for (const k of ['tokenType', 'sessionState', 'scope', 'notBeforePolicy', 'domain']) {
      if (p.rawData?.[k] !== undefined) raw.auth[k] = p.rawData[k];
    }

    const tmp = `${settings.authPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(raw, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, settings.authPath);
    suppressWatchUntil = Date.now() + 2000;
    lastMtime = fs.statSync(settings.authPath).mtimeMs;
    console.log('[workbuddy] 新 token 已写回登录态文件（WorkBuddy App 将同步）');
  } catch (e: any) {
    console.warn(`[workbuddy] token 写回失败（不影响转发）: ${e.message}`);
  }
}

let cached: WorkBuddyAuthState | null = null;
let refreshing: Promise<WorkBuddyAuthState> | null = null;
let watcher: fs.FSWatcher | null = null;
let watchDebounce: NodeJS.Timeout | null = null;
let lastMtime = 0;
let suppressWatchUntil = 0;

function startAuthWatch(): void {
  if (watcher) return;
  const dir = path.dirname(settings.authPath);
  const base = path.basename(settings.authPath);
  try {
    fs.mkdirSync(dir, { recursive: true });
    lastMtime = fs.existsSync(settings.authPath) ? fs.statSync(settings.authPath).mtimeMs : 0;
    watcher = fs.watch(dir, (_event, filename) => {
      if (filename !== base) return;
      if (watchDebounce) clearTimeout(watchDebounce);
      watchDebounce = setTimeout(() => {
        watchDebounce = null;
        if (Date.now() < suppressWatchUntil) return;
        try {
          const mtime = fs.statSync(settings.authPath).mtimeMs;
          if (mtime === lastMtime) return;
          lastMtime = mtime;
          const fresh = readAuthFile();
          cached = fresh;
          console.log(`[workbuddy] 已同步 App 刷新后的登录态（有效期至 ${new Date(fresh.expiresAt).toISOString()}）`);
        } catch (e: any) {
          console.warn(`[workbuddy] 登录态文件变更后读取失败: ${e.message}`);
        }
      }, 800);
    });
    watcher.on('error', (err) => {
      console.warn(`[workbuddy] 登录态文件监听异常: ${err.message}，5s 后重试`);
      watcher = null;
      setTimeout(startAuthWatch, 5000);
    });
    console.log(`[workbuddy] 已监听登录态文件（${settings.authPath}）`);
  } catch (e: any) {
    console.warn(`[workbuddy] 启动登录态监听失败: ${e.message}`);
  }
}

export function initTokenManager(): void {
  startAuthWatch();
}

export function getCachedAuth(): WorkBuddyAuthState | null {
  return cached;
}

export function getAuthStatus(): {
  loggedIn: boolean;
  uid?: string;
  source?: string;
  domain?: string;
  expiresAt?: string;
  refreshExpiresAt?: string;
  hasRefreshToken?: boolean;
} {
  if (!cached) return { loggedIn: false };
  return {
    loggedIn: Date.now() < cached.expiresAt,
    uid: cached.uid,
    source: cached.source,
    domain: cached.domain,
    expiresAt: new Date(cached.expiresAt).toISOString(),
    refreshExpiresAt: cached.refreshExpiresAt ? new Date(cached.refreshExpiresAt).toISOString() : undefined,
    hasRefreshToken: Boolean(cached.refreshToken),
  };
}

/**
 * 获取有效 token：
 * 1) 内存缓存（提前 5min 视为过期）
 * 2) 重读 auth 文件（App 可能刚刷新过）
 * 3) 用 refresh token 换新（并写回文件）
 * 4) .env 灾备凭证
 */
export async function getToken(): Promise<WorkBuddyAuthState> {
  if (cached && Date.now() < cached.expiresAt - settings.refreshAheadMs) return cached;
  if (refreshing) return refreshing;

  refreshing = (async () => {
    const fromFile = tryReadAuthFile();
    if (fromFile) {
      cached = fromFile;
      if (Date.now() < fromFile.expiresAt - settings.refreshAheadMs) return fromFile;
    }

    const base = cached ?? fromFile ?? loadFromEnv();
    if (!base) {
      throw new Error('无可用登录态：请打开 WorkBuddy 登录，或在 .env 配置 WORKBUDDY_ACCESS_TOKEN');
    }

    const p = await requestRefreshToken(base);
    const next: WorkBuddyAuthState = {
      accessToken: p.accessToken,
      refreshToken: p.refreshToken ?? base.refreshToken,
      uid: base.uid || decodeJwtPayload(p.accessToken).sub || '',
      domain: (p.rawData?.domain as string) || base.domain,
      expiresAt: p.expiresAt ?? (p.expiresIn ? Date.now() + p.expiresIn * 1000 : jwtExpiresAt(p.accessToken)),
      refreshExpiresAt:
        p.refreshExpiresAt ??
        (p.refreshExpiresIn ? Date.now() + p.refreshExpiresIn * 1000 : base.refreshExpiresAt),
      raw: base.raw,
      source: base.source,
    };
    persistAuthFile(base, p);
    cached = next;
    console.log(`[workbuddy] token 已刷新（有效期至 ${new Date(next.expiresAt).toISOString()}）`);
    return next;
  })().finally(() => {
    refreshing = null;
  });

  return refreshing;
}

/** 强制刷新（上游 401 时重试一次） */
export async function forceRefresh(): Promise<WorkBuddyAuthState> {
  if (refreshing) return refreshing;
  const base = tryReadAuthFile() ?? cached ?? loadFromEnv();
  if (!base) throw new Error('无可用登录态，无法刷新');
  refreshing = (async () => {
    const p = await requestRefreshToken(base);
    const next: WorkBuddyAuthState = {
      accessToken: p.accessToken,
      refreshToken: p.refreshToken ?? base.refreshToken,
      uid: base.uid || decodeJwtPayload(p.accessToken).sub || '',
      domain: (p.rawData?.domain as string) || base.domain,
      expiresAt: p.expiresAt ?? (p.expiresIn ? Date.now() + p.expiresIn * 1000 : jwtExpiresAt(p.accessToken)),
      refreshExpiresAt:
        p.refreshExpiresAt ??
        (p.refreshExpiresIn ? Date.now() + p.refreshExpiresIn * 1000 : base.refreshExpiresAt),
      raw: base.raw,
      source: base.source,
    };
    persistAuthFile(base, p);
    cached = next;
    console.log(`[workbuddy] token 已强制刷新（有效期至 ${new Date(next.expiresAt).toISOString()}）`);
    return next;
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/** 采纳外部凭据（诊断脚本用） */
export function adoptCredential(state: WorkBuddyAuthState): void {
  cached = state;
}
