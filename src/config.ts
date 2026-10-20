import dotenv from 'dotenv';
import os from 'node:os';
import path from 'node:path';

dotenv.config();

function env(key: string, fallback: string): string {
  const v = process.env[key];
  return v !== undefined && v !== '' ? v : fallback;
}

/** WorkBuddy 登录态文件（CodeBuddyExtension sharedDataPath/auth/<authId>.info） */
export function detectAuthPath(): string {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info');
  }
  return path.join(os.homedir(), 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info');
}

/** WorkBuddy 可执行文件（仅用于读取 at-rest 密钥：ELECTRON_RUN_AS_NODE + 自定义 binding） */
export function detectAppPath(): string {
  if (process.platform === 'win32') {
    return 'C:\\Program Files\\WorkBuddy\\WorkBuddy.exe';
  }
  return '/Applications/WorkBuddy.app/Contents/MacOS/WorkBuddy';
}

export interface Settings {
  port: number;

  // —— WorkBuddy 网关 ——
  baseUrl: string;
  domain: string;
  ideVersion: string;
  product: string;
  chatPath: string;
  refreshPath: string;
  modelsPath: string;

  // —— 本机凭证 ——
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
  domain: env('WORKBUDDY_DOMAIN', 'www.workbuddy.cn'),
  ideVersion: env('WORKBUDDY_IDE_VERSION', '5.8.3'),
  product: env('WORKBUDDY_PRODUCT', 'SaaS'),
  chatPath: env('WORKBUDDY_CHAT_PATH', '/v2/chat/completions'),
  refreshPath: env('WORKBUDDY_REFRESH_PATH', '/v2/plugin/auth/token/refresh'),
  modelsPath: env('WORKBUDDY_MODELS_PATH', '/v2/enterprises/personal/models'),

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
