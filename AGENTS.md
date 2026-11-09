# AGENTS.md — xrp-workbuddy

本文件为 AI Agent 划定项目边界。在本仓库工作时必须遵守以下约束。

## 概述

- 本项目是 **WorkBuddy / CodeBuddy 通道的 xrl-router 插件**：把 WorkBuddy 官方网关包装成 OpenAI Chat Completions 兼容的本地服务
- 上游：`https://copilot.tencent.com`（登录网关 `https://www.workbuddy.cn`，二者共用同一 state 存储）
- 凭证：**仅支持自包含网页登录**（state 握手 → 浏览器 → 轮询换票），DPAPI/AES 加密落盘；不依赖 WorkBuddy App
- 协议边界：只桥接 OpenAI Chat Completions（`/v1/chat/completions`）；Anthropic Messages 客户端由 xrl-router 转换后调用本插件

## 边界与范围

- 范围内：OpenAI Chat Completions 转发（流式 + 非流式聚合）、自包含网页登录/换票/续期/加密落盘、模型目录拉取、WebSocket 插件注册/心跳/重连（V24 契约）、SSE 分片归一化、上游指纹清洗
- 非目标（明确排除）：
  - **不实现 Anthropic Messages API** — 由 xrl-router 负责协议转换
  - **不做密钥轮转 / 多 key 负载均衡** — xrl-router 的职责
  - **不做本地模型推理** — 纯远端转发
  - **不暴露 `/v1/models` HTTP 端点** — 模型通过 WebSocket 注册推送
  - **不实现 `/v1/embeddings`、`/v1/completions` 等端点**
  - **不兼容旧版 WorkBuddy App 登录态** — 仅走自包含网页登录
  - **不复用/抓取他人凭证** — 只使用当前机器登录用户自己的账号

## Agent 操作指南

### 全局约定

- 包管理器：**pnpm**（不要用 npm）
- dev 运行：**tsx**（无 watch，修改后需手动重启）
- HTTP 框架：**Hono**
- `.env` 永不进 git（`git check-ignore .env` 必须通过）；自包含凭证文件同样不进 git
- 日志与脚本禁止输出 token / refresh token / at-rest secret 明文
- 凭证静态加密：Windows 默认 DPAPI（绑本机本用户），设 `WORKBUDDY_AUTH_SECRET` 则用 AES；明文不进命令行

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

### 指纹清洗（不要删除）

`src/client.ts` 的 `sanitizeUpstreamMessages` 在出站前改写客户端身份指纹文本，删除会导致对应客户端全量 400（code 11128）。匹配器**会归一化零宽/不可见字符**，所以改写全部是可见的语义等价微调（插零宽空格的方案已实测失效）：

- `Anthropic's official CLI for Claude` → 去 `'s`（Claude Code 身份句）
- `Main branch (you will usually use this for PRs)` → 删除括注（git 仓库环境块；裸括注不触发，需完整组合）
- `x-anthropic-billing-header` → 去 `x-` 前缀（计费头指纹）
- `You are an AI agent powered by DeepSeek Harness` → `agent` 后插逗号（DSH 身份**整句**才触发；裸 `DeepSeek Harness` 不拦截）
- Codex 各身份行实测放行（2026-11-09），未加规则；名单随网关版本变化，复测用直连探针二分（方法见 `docs/WORKBUDDY_REVERSE.md` 第 5.1 节）
- **路径安全**：规则只匹配完整指纹句，不碰裸词组与文件路径（如 `D:\...\DeepSeek Harness\...`），避免污染模型回传给工具的路径
- 清洗覆盖 messages 内全部文本：任意 role 的字符串 content、`text` 分片、`tool_calls` 参数
- 细节见 `docs/WORKBUDDY_REVERSE.md` 第 5.1 节

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
6. **「删除指纹清洗逻辑」** → 上游 11128 拦截会让 Claude Code 无法使用

## 目录速查

- `src/index.ts` — Hono 入口：路由、端口释放、启动
- `src/config.ts` — Settings 单例，集中读取环境变量
- `src/pluginClient.ts` — WebSocket 注册 / 心跳 / 重连（V24 无 keys）
- `src/client.ts` — 网关转发、模型目录、SSE 解析与归一化、指纹清洗、非流式聚合
- `src/auth.ts` — token 编排：内存缓存 → 本地凭证存储 → refresh 续期 → 网页登录
- `src/webLogin.ts` — 自包含网页登录：state 握手 → 浏览器 → 轮询换票 → 取账号
- `src/credentialStore.ts` — 凭证静态加密落盘（DPAPI / AES / 明文三形态）
- `src/jwt.ts` — JWT payload 解码（取 exp/sub）
- `scripts/login.ts` — 交互式网页登录入口
- `scripts/check-auth.ts` — 登录态与网关诊断
- `scripts/refresh-token.ts` — 强制续期（需 `--yes`）
- `docs/WORKBUDDY_REVERSE.md` — 逆向记录与协议细节（第 9 节：自包含登录）
