/**
 * webLogin.ts — 自包含网页登录（OAuth 式 device/state 握手），完全不依赖 WorkBuddy App。
 *
 * 逆向结论（详见 docs/WORKBUDDY_REVERSE.md 第 9 节，已实测）：
 *   1) 申请握手：POST {base}/v2/plugin/auth/state?platform=workbuddy
 *      头带 X-No-Authorization / X-No-User-Id / X-No-Enterprise-Id / X-No-Department-Info（表明"未登录"）
 *      → { code:0, data:{ state, authUrl } }
 *      authUrl 形如 https://www.workbuddy.cn/login?platform=workbuddy&state=<state>
 *   2) 训练员在浏览器完成登录（扫码 / 账号密码，由腾讯托管，插件不经手口令）
 *   3) 轮询换票：GET {base}/v2/plugin/auth/token?state=<state>
 *      未登录：{ code:11217, msg:"...login ing..." }（HTTP 仍 200）
 *      已登录：{ code:0, data:{ accessToken, refreshToken, expiresIn, refreshExpiresIn, domain?, ... } }
 *   4) 取账号：GET {base}/v2/plugin/account  Authorization: Bearer <accessToken>
 *      → { code:0, data:{ uid, domain?, type, nickname, ... } }
 *
 * copilot.tencent.com 与 www.workbuddy.cn 共用同一 state 存储，任一端换票皆可。
 * 插件不需要、也拿不到腾讯登录页的账号密码——它只是发起 state、把 authUrl 交给浏览器、再轮询取票。
 */

import { spawn } from 'node:child_process';
import { settings } from './config';
import { decodeJwtPayload } from './jwt';

/** 尽力在系统默认浏览器打开 URL；失败不抛错（终端会打印链接供手动打开） */
export function openExternal(url: string): void {
  const cmd =
    process.platform === 'win32'
      ? { file: 'cmd', args: ['/c', 'start', '""', url] }
      : process.platform === 'darwin'
        ? { file: 'open', args: [url] }
        : { file: 'xdg-open', args: [url] };
  try {
    const child = spawn(cmd.file, cmd.args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* 忽略：链接已打印 */
  }
}

/** 握手期"未登录"标记头（网关据此放行无凭证的 state/token 请求） */
export function preLoginHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'X-No-Authorization': 'true',
    'X-No-User-Id': 'true',
    'X-No-Enterprise-Id': 'true',
    'X-No-Department-Info': 'true',
    'X-Product': settings.product,
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': settings.ideVersion,
    'X-Domain': settings.domain,
    'User-Agent': `WorkBuddy/${settings.ideVersion}`,
    'Accept': 'application/json',
    'x-requested-with': 'XMLHttpRequest',
    ...extra,
  };
}

export interface LoginHandshake {
  state: string;
  authUrl: string;
}

interface ApiEnvelope {
  code?: number;
  msg?: string;
  data?: any;
  requestId?: string;
}

function num(v: any): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/** 申请 state 与浏览器登录 URL */
export async function requestHandshake(signal?: AbortSignal): Promise<LoginHandshake> {
  const url = `${settings.authBaseUrl}${settings.authStatePath}?platform=${encodeURIComponent(settings.platform)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: preLoginHeaders({ 'Content-Type': 'application/json' }),
    body: '{}',
    signal: signal ?? AbortSignal.timeout(20_000),
  });
  const env = (await res.json().catch(() => null)) as ApiEnvelope | null;
  if (!res.ok || !env || env.code !== 0) {
    throw new Error(`登录握手失败: HTTP ${res.status} code=${env?.code ?? '?'} ${env?.msg ?? ''}`.trim());
  }
  const state = typeof env.data?.state === 'string' ? env.data.state.trim() : '';
  const authUrl = typeof env.data?.authUrl === 'string' ? env.data.authUrl : '';
  if (!state || !authUrl) throw new Error('登录握手响应缺少 state / authUrl');
  return { state, authUrl };
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  refreshExpiresAt?: number;
  domain?: string;
  tokenType?: string;
  scope?: string;
  raw: any;
}

/** 轮询一次换票：返回 'pending' 或已签发的 token */
export async function pollOnce(state: string, signal?: AbortSignal): Promise<IssuedTokens | 'pending'> {
  const url = `${settings.authBaseUrl}${settings.authTokenPath}?state=${encodeURIComponent(state)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: preLoginHeaders(),
    signal: signal ?? AbortSignal.timeout(20_000),
  });
  const env = (await res.json().catch(() => null)) as ApiEnvelope | null;

  if (res.ok && env && env.code === settings.loginPendingCode) return 'pending';

  if (!res.ok || !env || env.code !== 0) {
    throw new Error(`换票失败: HTTP ${res.status} code=${env?.code ?? '?'} ${env?.msg ?? ''}`.trim());
  }
  const data = env.data?.data ?? env.data;
  const accessToken = data?.accessToken ?? data?.access_token;
  if (typeof accessToken !== 'string' || !accessToken) throw new Error('换票响应缺少 accessToken');
  const refreshToken = typeof (data.refreshToken ?? data.refresh_token) === 'string' ? (data.refreshToken ?? data.refresh_token) : '';
  const now = Date.now();
  const expiresAt = num(data.expiresAt) ?? (num(data.expiresIn) ? now + num(data.expiresIn)! * 1000 : jwtExp(accessToken, now));
  const refreshExpiresAt =
    num(data.refreshExpiresAt) ?? (num(data.refreshExpiresIn) ? now + num(data.refreshExpiresIn)! * 1000 : undefined);
  return {
    accessToken,
    refreshToken,
    expiresAt,
    refreshExpiresAt,
    domain: typeof data.domain === 'string' ? data.domain : undefined,
    tokenType: typeof data.tokenType === 'string' ? data.tokenType : undefined,
    scope: typeof data.scope === 'string' ? data.scope : undefined,
    raw: data,
  };
}

function jwtExp(token: string, fallback: number): number {
  const exp = Number(decodeJwtPayload(token).exp);
  return Number.isFinite(exp) && exp > 0 ? exp * 1000 : fallback + 24 * 3600_000;
}

export interface AccountInfo {
  uid: string;
  domain?: string;
  nickname?: string;
  type?: string;
  raw: any;
}

/** 用 access token 换取账号信息（uid / domain） */
export async function fetchAccount(accessToken: string, domain: string, signal?: AbortSignal): Promise<AccountInfo | null> {
  const url = `${settings.authBaseUrl}${settings.accountPath}`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'X-Product': settings.product,
        'X-IDE-Type': 'WorkBuddy',
        'X-IDE-Name': 'WorkBuddy',
        'X-IDE-Version': settings.ideVersion,
        'X-Private-Data': 'true',
        'X-Domain': domain || settings.domain,
        'User-Agent': `WorkBuddy/${settings.ideVersion}`,
        'Accept': 'application/json',
      },
      signal: signal ?? AbortSignal.timeout(15_000),
    });
    const env = (await res.json().catch(() => null)) as ApiEnvelope | null;
    if (!res.ok || !env || env.code !== 0) return null;
    const data = env.data?.data ?? env.data;
    const uid = typeof data?.uid === 'string' ? data.uid : decodeJwtPayload(accessToken).sub ?? '';
    return {
      uid,
      domain: typeof data?.domain === 'string' ? data.domain : undefined,
      nickname: typeof data?.nickname === 'string' ? data.nickname : undefined,
      type: typeof data?.type === 'string' ? data.type : undefined,
      raw: data,
    };
  } catch {
    return null;
  }
}

/**
 * 阻塞式登录：轮询直到拿到 token、被中止或超时。
 * @param onUrl 拿到 authUrl 时回调（用于打印 / 打开浏览器）
 */
export async function waitForLogin(
  handshake: LoginHandshake,
  opts: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal; onUrl?: (h: LoginHandshake) => void } = {},
): Promise<IssuedTokens> {
  opts.onUrl?.(handshake);
  const deadline = Date.now() + (opts.timeoutMs ?? settings.loginTimeoutMs);
  const interval = opts.intervalMs ?? settings.loginPollMs;
  for (;;) {
    if (opts.signal?.aborted) throw new Error('登录已取消');
    if (Date.now() > deadline) throw new Error('登录超时（5 分钟内未完成浏览器登录）');
    const r = await pollOnce(handshake.state, opts.signal);
    if (r !== 'pending') return r;
    await new Promise((res) => setTimeout(res, interval));
  }
}
