/**
 * auth.ts — 自包含凭证管理（不依赖 WorkBuddy App）。
 *
 * token 获取顺序：
 *   1) 内存缓存（提前 refreshAheadMs 视为过期）
 *   2) 本地凭证存储（credentialStore：DPAPI/AES/明文）
 *   3) 用 refresh token 续期（POST /v2/plugin/auth/token/refresh），并写回存储
 *   4) 触发网页登录（webLogin：state → 浏览器 → 轮询换票 → 取账号），并写回存储
 *
 * 旧版兼容：WORKBUDDY_USE_LEGACY_APP=1 时，在第 2 步之前先尝试读取并解密
 * WorkBuddy App 的登录态文件（需要本机安装 App + Electron binding 取 at-rest 密钥）。
 * 默认关闭，因此本插件可在没有 WorkBuddy 的机器上独立运行。
 */

import { settings } from './config';
import { decodeJwtPayload, jwtExpiresAt } from './jwt';
import * as store from './credentialStore';
import { requestHandshake, waitForLogin, fetchAccount, openExternal, type IssuedTokens } from './webLogin';

export interface WorkBuddyAuthState {
  accessToken: string;
  refreshToken: string;
  uid: string;
  domain: string;
  expiresAt: number;
  refreshExpiresAt?: number;
  /** 旧版兼容：App 登录态原始 JSON（仅 useLegacyApp 命中时有值） */
  raw?: any;
  source: 'file' | 'env' | 'cache' | 'store' | 'web';
}

export { decodeJwtPayload };

/** 落盘用的精简凭证（不含 raw） */
interface StoredCredential {
  accessToken: string;
  refreshToken: string;
  uid: string;
  domain: string;
  expiresAt: number;
  refreshExpiresAt?: number;
  savedAt: number;
}

function toStored(s: WorkBuddyAuthState): StoredCredential {
  return {
    accessToken: s.accessToken,
    refreshToken: s.refreshToken,
    uid: s.uid,
    domain: s.domain,
    expiresAt: s.expiresAt,
    refreshExpiresAt: s.refreshExpiresAt,
    savedAt: Date.now(),
  };
}

function storeOpts() {
  return { file: settings.credentialPath, mode: settings.storeMode, secret: settings.authSecret || undefined };
}

/** 读本地凭证存储；缺失或损坏返回 null */
function readStore(): WorkBuddyAuthState | null {
  try {
    const blob = store.readBlob(settings.credentialPath);
    if (!blob) return null;
    const c = store.open<StoredCredential>(storeOpts(), blob);
    if (!c || typeof c.accessToken !== 'string' || !c.accessToken) return null;
    return {
      accessToken: c.accessToken,
      refreshToken: c.refreshToken || '',
      uid: c.uid || decodeJwtPayload(c.accessToken).sub || '',
      domain: c.domain || settings.domain,
      expiresAt: Number(c.expiresAt) || jwtExpiresAt(c.accessToken),
      refreshExpiresAt: c.refreshExpiresAt,
      source: 'store',
    };
  } catch (e: any) {
    console.warn(`[workbuddy] 读取本地凭证失败: ${e.message}`);
    return null;
  }
}

/** 原子写本地凭证存储（加密形态自动选择） */
function writeStore(s: WorkBuddyAuthState): void {
  try {
    const rec = store.seal(storeOpts(), toStored(s));
    store.writeBlob(settings.credentialPath, rec.blob);
  } catch (e: any) {
    console.warn(`[workbuddy] 写入本地凭证失败: ${e.message}`);
  }
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

interface RefreshPayload {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  refreshExpiresAt?: number;
  expiresIn?: number;
  refreshExpiresIn?: number;
  domain?: string;
  rawData: any;
}

function num(v: any): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/** 用 refresh token 续期（/v2/plugin/auth/token/refresh） */
async function requestRefreshToken(state: WorkBuddyAuthState): Promise<RefreshPayload> {
  if (!state.refreshToken) throw new Error('没有 refresh token，需要重新登录');
  const url = `${settings.baseUrl}${settings.refreshPath}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-Refresh-Token': state.refreshToken,
    'X-Auth-Refresh-Source': 'plugin',
    'X-Domain': state.domain || settings.domain,
    'X-Product': settings.product,
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': settings.ideVersion,
    'X-Private-Data': 'true',
    'User-Agent': `WorkBuddy/${settings.ideVersion}`,
    'x-requested-with': 'XMLHttpRequest',
  };
  if (state.uid) headers['X-User-Id'] = state.uid;

  const res = await fetch(url, { method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(30_000) });
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
  if (typeof accessToken !== 'string' || !accessToken) throw new Error('刷新令牌响应缺少 accessToken');
  return {
    accessToken,
    refreshToken:
      typeof (data.refreshToken ?? data.refresh_token) === 'string' ? (data.refreshToken ?? data.refresh_token) : undefined,
    expiresAt: num(data.expiresAt),
    refreshExpiresAt: num(data.refreshExpiresAt),
    expiresIn: num(data.expiresIn),
    refreshExpiresIn: num(data.refreshExpiresIn),
    domain: typeof data.domain === 'string' ? data.domain : undefined,
    rawData: data,
  };
}

function applyRefresh(base: WorkBuddyAuthState, p: RefreshPayload): WorkBuddyAuthState {
  return {
    accessToken: p.accessToken,
    refreshToken: p.refreshToken ?? base.refreshToken,
    uid: base.uid || decodeJwtPayload(p.accessToken).sub || '',
    domain: p.domain || base.domain,
    expiresAt: p.expiresAt ?? (p.expiresIn ? Date.now() + p.expiresIn * 1000 : jwtExpiresAt(p.accessToken)),
    refreshExpiresAt:
      p.refreshExpiresAt ?? (p.refreshExpiresIn ? Date.now() + p.refreshExpiresIn * 1000 : base.refreshExpiresAt),
    raw: base.raw,
    source: base.source === 'cache' ? 'store' : base.source,
  };
}

function tokensToState(t: IssuedTokens, uid: string, domain: string): WorkBuddyAuthState {
  return {
    accessToken: t.accessToken,
    refreshToken: t.refreshToken,
    uid: uid || decodeJwtPayload(t.accessToken).sub || '',
    domain: domain || t.domain || settings.domain,
    expiresAt: t.expiresAt,
    refreshExpiresAt: t.refreshExpiresAt,
    source: 'web',
  };
}

let cached: WorkBuddyAuthState | null = null;
let refreshing: Promise<WorkBuddyAuthState> | null = null;

/** 旧版兼容钩子：useLegacyApp 开启时读取并解密 App 登录态（在 legacy.ts 实现） */
let legacyReader: (() => WorkBuddyAuthState | null) | null = null;
export function registerLegacyReader(fn: () => WorkBuddyAuthState | null): void {
  legacyReader = fn;
}

/** 交互式网页登录：握手 → 打开浏览器 → 轮询换票 → 取账号 → 落盘 */
export async function interactiveLogin(opts: { openBrowser?: (url: string) => void; signal?: AbortSignal } = {}): Promise<WorkBuddyAuthState> {
  const hs = await requestHandshake(opts.signal);
  console.log('\n=== WorkBuddy 网页登录 ===');
  console.log(`请在浏览器完成登录（扫码或账号密码，${Math.round(settings.loginTimeoutMs / 60000)} 分钟内有效）：\n  ${hs.authUrl}\n`);
  const opener = opts.openBrowser ?? openExternal;
  opener(hs.authUrl);
  console.log('等待登录完成…');

  const tokens = await waitForLogin(hs, { signal: opts.signal });
  const acct = await fetchAccount(tokens.accessToken, tokens.domain || settings.domain);
  const state = tokensToState(tokens, acct?.uid || '', acct?.domain || tokens.domain || settings.domain);
  writeStore(state);
  cached = state;
  console.log(`登录成功：uid=${state.uid || '<空>'} 账号=${acct?.nickname || acct?.type || '未知'} 有效期至 ${new Date(state.expiresAt).toISOString()}`);
  console.log(`凭证已加密保存到 ${settings.credentialPath}（存储形态 ${store.describeKind(store.readBlob(settings.credentialPath))}）`);
  return state;
}

/**
 * 获取有效 token：缓存 → 本地存储 →（旧版 App）→ 刷新 → 网页登录。
 */
export async function getToken(): Promise<WorkBuddyAuthState> {
  if (cached && Date.now() < cached.expiresAt - settings.refreshAheadMs) return cached;
  if (refreshing) return refreshing;

  refreshing = (async () => {
    // 1) 本地存储
    const fromStore = readStore();
    if (fromStore) {
      cached = fromStore;
      if (Date.now() < fromStore.expiresAt - settings.refreshAheadMs) return fromStore;
    }

    // 2) 旧版兼容（可选）：读取并解密 App 登录态
    if (settings.useLegacyApp && legacyReader) {
      const legacy = legacyReader();
      if (legacy) {
        writeStore(legacy);
        cached = legacy;
        if (Date.now() < legacy.expiresAt - settings.refreshAheadMs) return legacy;
      }
    }

    // 3) 有 refresh token 就续期
    const base = cached ?? fromStore ?? loadFromEnv();
    if (base?.refreshToken) {
      try {
        const p = await requestRefreshToken(base);
        const next = applyRefresh(base, p);
        writeStore(next);
        cached = next;
        console.log(`[workbuddy] token 已刷新（有效期至 ${new Date(next.expiresAt).toISOString()}）`);
        return next;
      } catch (e: any) {
        console.warn(`[workbuddy] 续期失败，转网页登录: ${e.message}`);
      }
    }

    // 4) 网页登录（仅在允许自动登录时；否则抛错，引导用 pnpm login）
    if (!settings.autoLogin) {
      throw new Error(
        '无有效登录态。请先运行 `pnpm login` 完成网页登录，' +
          '或在 .env 设置 WORKBUDDY_AUTO_LOGIN=1 允许服务自动发起登录。',
      );
    }
    return interactiveLogin();
  })().finally(() => {
    refreshing = null;
  });

  return refreshing;
}

/** 强制刷新（上游 401 时重试一次）；刷新不成则落回网页登录（仅 autoLogin 开启时） */
export async function forceRefresh(): Promise<WorkBuddyAuthState> {
  if (refreshing) return refreshing;
  const base = readStore() ?? cached ?? loadFromEnv();
  if (!base?.refreshToken) {
    cached = null;
    if (!settings.autoLogin) throw new Error('无 refresh token，无法刷新；请运行 `pnpm login` 重新登录');
    return interactiveLogin();
  }
  refreshing = (async () => {
    try {
      const p = await requestRefreshToken(base);
      const next = applyRefresh(base, p);
      writeStore(next);
      cached = next;
      console.log(`[workbuddy] token 已强制刷新（有效期至 ${new Date(next.expiresAt).toISOString()}）`);
      return next;
    } catch (e: any) {
      cached = null;
      if (!settings.autoLogin) {
        console.warn(`[workbuddy] 强制刷新失败（登录态可能已失效）: ${e.message}`);
        throw new Error('refresh token 续期失败，请运行 `pnpm login` 重新登录');
      }
      console.warn(`[workbuddy] 强制刷新失败，转网页登录: ${e.message}`);
      return interactiveLogin();
    }
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
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
  credentialPath: string;
  storeKind: string;
  legacyApp: boolean;
} {
  const kind = store.describeKind(store.readBlob(settings.credentialPath));
  const base = {
    credentialPath: settings.credentialPath,
    storeKind: kind,
    legacyApp: settings.useLegacyApp,
  };
  if (!cached) return { loggedIn: false, ...base };
  return {
    loggedIn: Date.now() < cached.expiresAt,
    uid: cached.uid,
    source: cached.source,
    domain: cached.domain,
    expiresAt: new Date(cached.expiresAt).toISOString(),
    refreshExpiresAt: cached.refreshExpiresAt ? new Date(cached.refreshExpiresAt).toISOString() : undefined,
    hasRefreshToken: Boolean(cached.refreshToken),
    ...base,
  };
}

/** 启动期无阻塞探测：填充缓存但不触发登录，返回状态 */
export function initTokenManager(): void {
  cached = readStore() ?? (settings.useLegacyApp && legacyReader ? legacyReader() : null);
}

/** 采纳外部凭据（诊断脚本用） */
export function adoptCredential(state: WorkBuddyAuthState): void {
  cached = state;
}
