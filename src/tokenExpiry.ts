/**
 * tokenExpiry.ts — token 过期时间归一化与缓存命中判定（纯函数，无 IO）。
 *
 * 三个必须守住的约束：
 * 1) 上游 `expiresAt` 可能在秒级 / 毫秒级之间摇摆 → 统一归一化为毫秒
 * 2) 以 JWT `exp` 作为过期时间上界（签发方权威值），垃圾值不会让缓存永久失效
 * 3) 提前刷新量不超过剩余 TTL 的 10%，避免 TTL 缩短后每个请求都触发刷新
 */

import { decodeJwtPayload, jwtExpiresAt } from './jwt';

/** 提前刷新量的回退值（配置缺失 / 非法时使用） */
export const DEFAULT_REFRESH_AHEAD_MS = 5 * 60_000;

export interface ExpiryCarrier {
  accessToken: string;
  expiresAt: number;
}

/** 时间戳归一化为毫秒；非法值返回 0 */
export function toMs(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return 0;
  // 1e12 ms ≈ 2001 年；小于该值的正整数按「秒」处理
  return Math.round(n < 1e12 ? n * 1000 : n);
}

/** 有效过期时间：先归一化量级，再与 JWT exp 取较小值 */
export function normalizeExpiry(raw: unknown, accessToken?: string): number {
  const ms = toMs(raw);
  const jwt = accessToken ? jwtExpiresAt(accessToken) : 0;
  if (ms > 0 && jwt > 0) return Math.min(ms, jwt);
  return ms || jwt;
}

/** token 额定寿命（毫秒），取自 JWT 的 exp - iat；取不到返回 0 */
export function tokenLifetimeMs(accessToken?: string): number {
  if (!accessToken) return 0;
  const p = decodeJwtPayload(accessToken);
  const exp = Number(p.exp);
  const iat = Number(p.iat);
  if (!Number.isFinite(exp) || !Number.isFinite(iat) || iat <= 0 || exp <= iat) return 0;
  return (exp - iat) * 1000;
}

/**
 * 提前刷新量：min(配置值, 额定寿命的 10%)，且不低于 1 秒。
 *
 * 必须用「额定寿命」而不是「当前剩余时间」来算：用剩余时间会让窗口随剩余一起收缩，
 * 条件是 `now < exp - ttl*10%`，恒成立 → 永远进不了刷新窗口。
 * 取不到寿命（opaque token）时退回固定配置值。
 */
export function refreshAheadFor(expiresAt: number, configuredAheadMs: number, lifetimeMs = 0): number {
  const configured =
    Number.isFinite(configuredAheadMs) && configuredAheadMs >= 0 ? configuredAheadMs : DEFAULT_REFRESH_AHEAD_MS;
  if (lifetimeMs > 0) return Math.min(configured, Math.max(Math.floor(lifetimeMs * 0.1), 1_000));
  return configured;
}

/** 缓存是否可复用：token 非空 + 过期时间合法 + 不在提前刷新窗口内 */
export function isTokenUsable<T extends ExpiryCarrier>(
  s: T | null | undefined,
  configuredAheadMs: number,
  now = Date.now(),
): s is T {
  if (!s || typeof s.accessToken !== 'string' || !s.accessToken) return false;
  const exp = Number(s.expiresAt);
  if (!Number.isFinite(exp) || exp <= 0) return false;
  const ahead = refreshAheadFor(exp, configuredAheadMs, tokenLifetimeMs(s.accessToken));
  return now < exp - ahead;
}
