/**
 * 诊断：强制用 refresh token 续期一次，并写回本地凭证存储。
 * 注意：refresh token 会轮换；必须显式加 --yes 才会执行。
 * 若 refresh token 已失效，本脚本不会弹浏览器，请改用 `pnpm login`。
 * 用法：pnpm refresh-token -- --yes
 */

import { forceRefresh, getToken } from '../src/auth';

async function main(): Promise<void> {
  const before = await getToken().catch(() => null);
  if (before) console.log('current expiry:', new Date(before.expiresAt).toISOString());

  if (!process.argv.includes('--yes')) {
    console.log('未执行刷新：refresh token 会轮换，确认后请加 --yes');
    return;
  }

  const next = await forceRefresh();
  console.log('new expiry:', new Date(next.expiresAt).toISOString());
  console.log('refresh expiry:', next.refreshExpiresAt ? new Date(next.refreshExpiresAt).toISOString() : '<unknown>');
  console.log('access token length:', next.accessToken.length, '(redacted)');
  process.exit(0);
}

main().catch((e) => {
  console.error('refresh-token failed:', e.message);
  process.exit(1);
});
