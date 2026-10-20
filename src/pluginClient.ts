/**
 * PluginClient — 连接 xrl-router 的 WebSocket 客户端（V24 契约）。
 *
 * - 启动时先解析模型目录，再注册插件（不带 keys）
 * - 每 30s 心跳；断线指数退避重连（1s → 60s）
 * - 容忍 Router 未就绪
 */

import { WebSocket } from 'ws';
import { settings } from './config';
import { resolveModels, type WorkBuddyModelInfo } from './client';

const PLUGIN_ID = 'plugin-workbuddy';
const HEARTBEAT_INTERVAL_MS = 30_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;

export class PluginClient {
  private ws: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private models: WorkBuddyModelInfo[] = [];
  private started = false;

  constructor() {
    void this.bootstrap();
  }

  private async bootstrap(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.models = await resolveModels().catch(() => []);
    this.connect();
  }

  private connect(): void {
    const wsUrl = settings.xrlRouterUrl.replace(/^http/, 'ws') + '/ws/plugin';
    this.ws = new WebSocket(wsUrl);

    this.ws.on('open', () => {
      console.log('[PluginClient] Connected to xrl-router');
      this.reconnectAttempts = 0;
      this.sendRegister();
      this.startHeartbeat();
    });

    this.ws.on('message', (data) => {
      this.handleMessage(data.toString());
    });

    this.ws.on('close', () => {
      console.log('[PluginClient] Disconnected from xrl-router');
      this.stopHeartbeat();
      this.scheduleReconnect();
    });

    this.ws.on('error', (error) => {
      console.error('[PluginClient] WebSocket error:', error.message);
    });
  }

  /** 注册（V24：无 keys，kind=chat_completions，带 workdir） */
  private sendRegister(): void {
    // Router 以 display_name 作为客户端可调用的别名；用模型 ID 保证唯一且可预测
    // （目录里的 name 有重复，如 Hy3 / Hy3-X 都叫 "Hy3"）
    const models = this.models.map((m) => ({
      model_id: m.id,
      display_name: m.id,
      tier: 'custom',
    }));

    this.send({
      type: 'register',
      plugin_id: PLUGIN_ID,
      provider: {
        kind: 'chat_completions',
        base_url: `http://localhost:${settings.port}`,
        api_path: '/v1/chat/completions',
      },
      models,
      workdir: process.cwd(),
    });
    console.log(`[PluginClient] Registered ${models.length} models as ${PLUGIN_ID}`);
  }

  private handleMessage(data: string): void {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'error') {
        console.error(`[PluginClient] Router error: ${msg.reason}`);
      }
    } catch {
      /* 无法解析的消息忽略 */
    }
  }

  private send(message: any): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: 'heartbeat' });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts), RECONNECT_MAX_MS);
    console.log(`[PluginClient] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts + 1})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectAttempts++;
      this.connect();
    }, delay);
  }

  public close(): void {
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
