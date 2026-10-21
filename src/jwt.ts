/** jwt.ts — 仅解 JWT payload（取 exp/sub 用），不校验签名。 */
export function decodeJwtPayload(token: string): any {
  try {
    const part = token.split('.')[1] || '';
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return {};
  }
}

export function jwtExpiresAt(token: string): number {
  const exp = Number(decodeJwtPayload(token).exp);
  return Number.isFinite(exp) && exp > 0 ? exp * 1000 : 0;
}
