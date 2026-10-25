/**
 * 诊断：检查自包含凭证存储与网关连通性（不打印任何 token）。
 * 用法：pnpm check-auth
 *
 * 默认（WORKBUDDY_AUTO_LOGIN=0）不弹浏览器：未登录时只提示 pnpm login。
 * 注意：若开启 autoLogin 且本地 token 已落在提前刷新窗口内，getToken 仍可能触发网页登录。
 */

import { initTokenManager, getAuthStatus, getToken } from '../src/auth';
import { fetchModelCatalog } from '../src/client';
import { settings } from '../src/config';

async function main(): Promise<void> {
  initTokenManager();
  console.log('登录网关      :', settings.authBaseUrl);
  console.log('推理网关      :', settings.baseUrl);
  console.log('凭证文件      :', settings.credentialPath);

  const status = getAuthStatus();
  console.log('登录状态      :', JSON.stringify(status, null, 2));

  if (!status.loggedIn) {
    console.log('\n尚未登录（或凭证缺失）。运行 `pnpm login` 完成网页登录。');
    process.exit(status.storeKind === 'none' ? 1 : 0);
  }

  // 凭证存在：再验证一次能否拿到有效 token（可能触发续期）
  const state = await getToken();
  console.log('uid           :', state.uid || '<empty>');
  console.log('domain        :', state.domain);
  console.log('source        :', state.source);
  console.log('access token  :', state.accessToken.length, 'chars (redacted)');
  console.log('refresh token :', state.refreshToken.length, 'chars (redacted)');
  console.log('expires at    :', new Date(state.expiresAt).toISOString());
  if (state.refreshExpiresAt) {
    console.log('refresh expires at:', new Date(state.refreshExpiresAt).toISOString());
  }

  const models = await fetchModelCatalog();
  console.log('gateway model catalog:', models.length, 'models');
  console.log('sample:', models.slice(0, 8).map((m) => `${m.id}=${m.name}`).join(', '));
  process.exit(0);
}

main().catch((e) => {
  console.error('check-auth failed:', e.message);
  process.exit(1);
});
