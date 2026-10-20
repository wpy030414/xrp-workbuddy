/**
 * 诊断：读取本机 WorkBuddy 登录态并验证网关连通性（不打印任何 token）。
 * 用法：pnpm check-auth
 */

import { initTokenManager, getToken, getAuthStatus } from '../src/auth';
import { fetchModelCatalog } from '../src/client';
import { settings } from '../src/config';

async function main(): Promise<void> {
  initTokenManager();
  console.log('auth file:', settings.authPath);
  console.log('app binary:', settings.appPath);

  const state = await getToken();
  console.log('uid:', state.uid || '<empty>');
  console.log('domain:', state.domain);
  console.log('source:', state.source);
  console.log('access token:', state.accessToken.length, 'chars (redacted)');
  console.log('refresh token:', state.refreshToken.length, 'chars (redacted)');
  console.log('expires at:', new Date(state.expiresAt).toISOString());
  if (state.refreshExpiresAt) {
    console.log('refresh expires at:', new Date(state.refreshExpiresAt).toISOString());
  }
  console.log('status:', JSON.stringify(getAuthStatus()));

  const models = await fetchModelCatalog();
  console.log('gateway model catalog:', models.length, 'models');
  console.log('sample:', models.slice(0, 8).map((m) => `${m.id}=${m.name}`).join(', '));
  process.exit(0);
}

main().catch((e) => {
  console.error('check-auth failed:', e.message);
  process.exit(1);
});
