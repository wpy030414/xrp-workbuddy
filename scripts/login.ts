/**
 * 网页登录（自包含）：state 握手 → 浏览器登录 → 轮询换票 → 取账号 → 加密落盘。
 * 完全不依赖 WorkBuddy App；凭证存入本地加密存储，供 pnpm serve 复用。
 * 用法：pnpm login
 */

import { interactiveLogin } from '../src/auth';
import { settings } from '../src/config';

async function main(): Promise<void> {
  console.log(`登录网关: ${settings.authBaseUrl}`);
  console.log(`推理网关: ${settings.baseUrl}`);
  console.log(`凭证文件: ${settings.credentialPath}`);

  const state = await interactiveLogin();
  console.log('\n登录完成。现在可以运行 `pnpm serve` 启动插件。');
  console.log(`uid=${state.uid || '<空>'}  domain=${state.domain}  有效期至 ${new Date(state.expiresAt).toISOString()}`);
  process.exit(0);
}

main().catch((e) => {
  console.error('login failed:', e.message);
  process.exit(1);
});
