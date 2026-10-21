/**
 * WorkBuddy 插件入口（xrl-router V24 契约）：
 * - HTTP：OpenAI Chat Completions 兼容（POST /v1/chat/completions）
 * - WebSocket：注册 / 心跳 / 重连（无 keys）
 */

import { serve } from '@hono/node-server';
import { spawn } from 'node:child_process';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { settings } from './config';
import { forwardChatCompletions } from './client';
import { getAuthStatus, initTokenManager, registerLegacyReader } from './auth';
import { readLegacyAppAuth } from './legacy';
import { PluginClient } from './pluginClient';

const PLUGIN_ID = 'plugin-workbuddy';

// 旧版兼容：仅当显式开启时，把 App 登录态读取接入凭证解析链
if (settings.useLegacyApp) registerLegacyReader(readLegacyAppAuth);

const app = new Hono();

app.use('*', cors());

app.get('/', (c) =>
  c.json({
    version: '0.1.0',
    service: PLUGIN_ID,
    status: 'running',
    backend: 'workbuddy',
    endpoints: { chat: '/v1/chat/completions', health: '/health' },
  }),
);

app.get('/health', (c) =>
  c.json({
    status: 'healthy',
    backend: 'workbuddy',
    plugin_mode: true,
    base_url: settings.baseUrl,
    auth: getAuthStatus(),
  }),
);

app.post('/v1/chat/completions', async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { message: '请求体必须是合法 JSON', type: 'invalid_request_error' } }, 400);
  }
  return forwardChatCompletions(body, c);
});

/** 释放被旧实例占用的端口（排除自身 PID） */
async function killPortProcess(port: number): Promise<void> {
  const isWindows = process.platform === 'win32';
  const selfPid = String(process.pid);
  return new Promise((resolve) => {
    if (isWindows) {
      const netstat = spawn('netstat', ['-ano']);
      let output = '';
      netstat.stdout.on('data', (d) => {
        output += d.toString();
      });
      netstat.on('close', () => {
        const pids: string[] = [];
        for (const line of output.split('\n')) {
          if (line.includes(`:${port}`) && line.includes('LISTENING')) {
            const parts = line.trim().split(/\s+/);
            const pid = parts[parts.length - 1];
            if (pid && pid !== selfPid && !pids.includes(pid)) pids.push(pid);
          }
        }
        if (pids.length === 0) return resolve();
        const taskkill = spawn('taskkill', ['/F', '/PID', ...pids]);
        taskkill.on('close', () => resolve());
      });
      netstat.on('error', () => resolve());
    } else {
      const lsof = spawn('lsof', ['-ti', `:${port}`]);
      let pids = '';
      lsof.stdout.on('data', (d) => {
        pids += d.toString();
      });
      lsof.stderr.on('data', () => {});
      lsof.on('close', (code) => {
        if (code === 0 && pids.trim()) {
          const pidList = pids.trim().split('\n').filter((p) => p.trim() && p.trim() !== selfPid);
          if (pidList.length === 0) return resolve();
          const kill = spawn('kill', ['-9', ...pidList]);
          kill.on('close', () => resolve());
        } else {
          resolve();
        }
      });
      lsof.on('error', () => resolve());
    }
  });
}

async function startServer(): Promise<void> {
  initTokenManager();
  await killPortProcess(settings.port);

  serve(
    {
      fetch: app.fetch,
      port: settings.port,
      hostname: '0.0.0.0',
    },
    (info) => {
      console.log(`[workbuddy] listening on http://localhost:${info.port} (pid ${process.pid})`);

      const pluginClient = new PluginClient();
      const shutdown = () => {
        pluginClient.close();
        process.exit(0);
      };
      process.on('SIGTERM', shutdown);
      process.on('SIGINT', shutdown);
    },
  );
}

startServer();

export default app;
