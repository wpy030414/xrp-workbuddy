# AGENTS.md — xrl-router-plugin-workbuddy

本文件为 AI Agent 划定项目边界。在本仓库工作时必须遵守以下约束。

## 概述

- 本项目是 **WorkBuddy / CodeBuddy 通道的 xrl-router 插件**：把 WorkBuddy 官方网关包装成 OpenAI Chat Completions 兼容的本地服务
- 上游：`https://copilot.tencent.com`（登录网关 `https://www.workbuddy.cn`，二者共用同一 state 存储）
- 凭证：自包含网页登录（state 握手 → 浏览器 → 轮询换票），DPAPI/AES 加密落盘；**默认不依赖 WorkBuddy App**
- 协议边界：只桥接 OpenAI Chat Completions（`/v1/chat/completions`）；Anthropic Messages 客户端由 xrl-router 转换后调用本插件

## 边界与范围

- 范围内：OpenAI Chat Completions 转发（流式 + 非流式聚合）、自包含网页登录/换票/续期/加密落盘、模型目录拉取、WebSocket 插件注册/心跳/重连（V24 契约）、SSE 分片归一化
- 非目标（明确排除）：
  - **不实现 Anthropic Messages API** — 由 xrl-router 负责协议转换
  - **不做密钥轮转 / 多 key 负载均衡** — xrl-router 的职责
  - **不做本地模型推理** — 纯远端转发
  - **不暴露 `/v1/models` HTTP 端点** — 模型通过 WebSocket 注册推送
  - **不实现 `/v1/embeddings`、`/v1/completions` 等端点**
  - **不复用/抓取他人凭证** — 只使用当前机器登录用户自己的账号

## Agent 操作指南

### 全局约定

- 包管理器：**pnpm**（不要用 npm）
- dev 运行：**tsx**（无 watch，修改后需手动重启）
- HTTP 框架：**Hono**
- `.env` 永不进 git（`git check-ignore .env` 必须通过）；自包含凭证文件同样不进 git
- 日志与脚本禁止输出 token / refresh token / at-rest secret 明文
- 凭证静态加密：Windows 默认 DPAPI（绑本机本用户），设 `WORKBUDDY_AUTH_SECRET` 则用 AES；明文不进命令行
- 仅当 `WORKBUDDY_USE_LEGACY_APP=1` 时才走旧版 App 解密；写回 App 登录态文件时必须复用原始信封 `keyId`（不可由密钥推导）

### V24 契约（不可破坏）

- 连接 `ws://127.0.0.1:19068/ws/plugin`
- register 消息字段：`plugin_id`、`provider.kind = "chat_completions"`、`provider.base_url`、`provider.api_path`、`models[]`、`workdir`
- **register 不带 `keys`**（带了 Router 直接拒绝并断开）
- **不发 `keys_update`**
- 心跳每 30s：`{"type":"heartbeat"}`，不带 timestamp
- 断线指数退避重连 1s → 60s
- Router 发给插件的是占位 Bearer；插件必须使用自身凭证访问上游

### 路由与别名

- Router 以 `display_name` 作为客户端可调用的模型别名，而不是 `model_id`
- 上游目录展示名有重复（如 `Hy3` / `Hy3-X` 同名），因此注册时 `display_name = model_id`
- 新注册的 provider 初始为 disabled/pending，需要 `POST /api/plugins/plugin-workbuddy/confirm` 才会启用

### SSE 归一化（不要删除）

`src/client.ts` 的 `normalizeStreamChunk` 补偿了 xrl-router 的两个转换行为，删除会导致 Anthropic 流式输出错乱：

1. Router 把 `finish_reason: ""` 当作结束信号 → 必须转成 `null`
2. Router 把空 `tool_calls: []` 数组当作块边界 → 必须剔除该字段
3. Router 把任何带 `function.name`（含空串）的分片当作新 tool_use 块 → 仅首分片带 `id/name`，续传分片只带 `index/arguments`

### 构建与运行

```bash
pnpm install
pnpm login             # 网页登录：打印 authUrl 并开浏览器，凭证加密落盘
pnpm check-auth        # 诊断登录态与模型目录（不打印 token）
pnpm serve             # 启动插件（19069）
pnpm refresh-token -- --yes   # 强制续期并写回本地凭证
pnpm typecheck
```

### 已知限制（不要尝试修复）

| 现状 | 原因 |
|---|---|
| 上游只支持流式 | 网关对非流式返回 400 / 11101；插件用聚合兼容客户端 |
| 首登需真人浏览器登录 | state 换票要训练员本人在腾讯托管页扫码/账密，插件不经手口令 |
| DPAPI 凭证不可跨机迁移 | 绑定本机本用户；要迁移就用 `WORKBUDDY_STORE_MODE=aes` + `WORKBUDDY_AUTH_SECRET` |
| 无自动化测试 | 当前以本机 E2E 脚本验证 |
| 模型目录可能随 WorkBuddy 版本变化 | 启动时动态拉取，不硬编码 |

### 必须拒绝的任务

1. **「实现 Anthropic Messages API」** → 由 xrl-router 负责
2. **「添加密钥轮转 / 多账号池」** → xrl-router 职责
3. **「实现本地模型推理」** → 纯转发插件
4. **「抓取或复用其他人的 WorkBuddy 凭证」** → 仅限本机登录用户本人
5. **「删除 SSE 归一化逻辑」** → 会破坏 Router 的 Anthropic 转换

## 目录速查

- `src/index.ts` — Hono 入口：路由、端口释放、启动（按需接入 legacy 兼容层）
- `src/config.ts` — Settings 单例，集中读取环境变量
- `src/pluginClient.ts` — WebSocket 注册 / 心跳 / 重连（V24 无 keys）
- `src/client.ts` — 网关转发、模型目录、SSE 解析与归一化、非流式聚合
- `src/auth.ts` — token 编排：内存缓存 → 本地凭证存储 → refresh 续期 → 网页登录
- `src/webLogin.ts` — 自包含网页登录：state 握手 → 浏览器 → 轮询换票 → 取账号
- `src/credentialStore.ts` — 凭证静态加密落盘（DPAPI / AES / 明文三形态）
- `src/jwt.ts` — JWT payload 解码（取 exp/sub）
- `src/legacy.ts` — 旧版 App 登录态解密/写回（仅 `WORKBUDDY_USE_LEGACY_APP=1` 时加载）
- `scripts/login.ts` — 交互式网页登录入口
- `scripts/check-auth.ts` — 登录态与网关诊断
- `scripts/refresh-token.ts` — 强制续期（需 `--yes`）
- `docs/WORKBUDDY_REVERSE.md` — 逆向记录与协议细节（第 9 节：自包含登录）
