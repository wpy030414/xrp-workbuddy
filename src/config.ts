import dotenv from 'dotenv';
import os from 'node:os';
import path from 'node:path';

dotenv.config();

function env(key: string, fallback: string): string {
  const v = process.env[key];
  return v !== undefined && v !== '' ? v : fallback;
}

function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

/** WorkBuddy 登录态文件（旧版兼容路径，仅在 WORKBUDDY_USE_LEGACY_APP=1 时读取） */
export function detectAuthPath(): string {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info');
  }
  return path.join(os.homedir(), 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info');
}

/** WorkBuddy 可执行文件（旧版兼容：读取 at-rest 密钥解密 App 登录态） */
export function detectAppPath(): string {
  if (process.platform === 'win32') {
    return 'C:/Program Files/WorkBuddy/WorkBuddy.exe';
  }
  return '/Applications/WorkBuddy.app/Contents/MacOS/WorkBuddy';
}

/** 自包含凭证文件默认落在用户数据目录，不进仓库 */
function detectCredentialPath(): string {
  const base =
    process.env.XDG_DATA_HOME ||
    (process.platform === 'win32'
      ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
      : path.join(os.homedir(), '.local', 'share'));
  return path.join(base.replace(/\/+$/, ''), 'xrl-router-plugin-workbuddy', 'workbuddy-credential.json');
}

export interface Settings {
  port: number;

  // —— WorkBuddy 网关 ——
  baseUrl: string;
  /** 登录握手 / 换票所用的 Web 网关域（默认与网页登录一致） */
  authBaseUrl: string;
  domain: string;
  ideVersion: string;
  product: string;
  platform: string;
  chatPath: string;
  refreshPath: string;
  modelsPath: string;

  // —— 网页登录（自包含 OAuth 式握手）——
  authStatePath: string;
  authTokenPath: string;
  accountPath: string;
  loginPendingCode: number;
  loginTimeoutMs: number;
  loginPollMs: number;
  /** 无凭证时，转发请求是否自动发起网页登录（默认 false，改用 pnpm login 显式登录） */
  autoLogin: boolean;

  // —— 凭证存储（自包含）——
  credentialPath: string;
  storeMode: 'auto' | 'dpapi' | 'aes' | 'plain';
  /** AES 模式 passphrase；为空则 Windows 用 DPAPI、其它平台明文 */
  authSecret: string;

  // —— 旧版兼容（依赖 WorkBuddy App；默认关闭）——
  useLegacyApp: boolean;
  authPath: string;
  appPath: string;

  refreshAheadMs: number;
  requestTimeoutMs: number;

  // —— 模型注册 ——
  /** 显式模型列表（逗号分隔）；空数组 = 启动时拉取云端目录 */
  availableModels: string[];

  // —— 灾备凭证 ——
  accessTokenEnv: string;
  refreshTokenEnv: string;
  userIdEnv: string;

  // —— xrl-router ——
  xrlRouterUrl: string;
}

export const settings: Settings = {
  port: parseInt(env('WORKBUDDY_PORT', '19069'), 10),

  baseUrl: env('WORKBUDDY_BASE_URL', 'https://copilot.tencent.com').replace(/\/+$/, ''),
  authBaseUrl: env('WORKBUDDY_AUTH_BASE_URL', 'https://www.workbuddy.cn').replace(/\/+$/, ''),
  domain: env('WORKBUDDY_DOMAIN', 'www.workbuddy.cn'),
  ideVersion: env('WORKBUDDY_IDE_VERSION', '5.8.3'),
  product: env('WORKBUDDY_PRODUCT', 'SaaS'),
  platform: env('WORKBUDDY_PLATFORM', 'workbuddy'),
  chatPath: env('WORKBUDDY_CHAT_PATH', '/v2/chat/completions'),
  refreshPath: env('WORKBUDDY_REFRESH_PATH', '/v2/plugin/auth/token/refresh'),
  modelsPath: env('WORKBUDDY_MODELS_PATH', '/v2/enterprises/personal/models'),

  authStatePath: env('WORKBUDDY_AUTH_STATE_PATH', '/v2/plugin/auth/state'),
  authTokenPath: env('WORKBUDDY_AUTH_TOKEN_PATH', '/v2/plugin/auth/token'),
  accountPath: env('WORKBUDDY_ACCOUNT_PATH', '/v2/plugin/account'),
  loginPendingCode: parseInt(env('WORKBUDDY_LOGIN_PENDING_CODE', '11217'), 10),
  loginTimeoutMs: parseInt(env('WORKBUDDY_LOGIN_TIMEOUT_MS', String(5 * 60_000)), 10),
  loginPollMs: parseInt(env('WORKBUDDY_LOGIN_POLL_MS', '1000'), 10),
  autoLogin: envBool('WORKBUDDY_AUTO_LOGIN', false),

  credentialPath: env('WORKBUDDY_CREDENTIAL_PATH', detectCredentialPath()),
  storeMode: (env('WORKBUDDY_STORE_MODE', 'auto') as Settings['storeMode']),
  authSecret: env('WORKBUDDY_AUTH_SECRET', ''),

  useLegacyApp: envBool('WORKBUDDY_USE_LEGACY_APP', false),
  authPath: env('WORKBUDDY_AUTH_PATH', detectAuthPath()),
  appPath: env('WORKBUDDY_APP_PATH', detectAppPath()),
  refreshAheadMs: parseInt(env('WORKBUDDY_REFRESH_AHEAD_MS', String(5 * 60_000)), 10),
  requestTimeoutMs: parseInt(env('WORKBUDDY_REQUEST_TIMEOUT_MS', '600000'), 10),

  availableModels: (process.env.WORKBUDDY_MODELS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  accessTokenEnv: env('WORKBUDDY_ACCESS_TOKEN', ''),
  refreshTokenEnv: env('WORKBUDDY_REFRESH_TOKEN', ''),
  userIdEnv: env('WORKBUDDY_USER_ID', ''),

  xrlRouterUrl: env('XRL_ROUTER_URL', 'http://localhost:19068'),
};
