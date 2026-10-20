# xrl-router-plugin-workbuddy

> WorkBuddy / CodeBuddy 通道的 xrl-router 插件 — 复用本机已登录的 WorkBuddy 凭证，把官方网关包装成 OpenAI Chat Completions 兼容服务。

```
OpenAI / Anthropic 客户端 → xrl-router :19068 → 本插件 :19069 → copilot.tencent.com
```

## 这是什么？

- xrl-router 的 WorkBuddy 通道插件，纯转发 / 协议适配层
- 直接读取本机 WorkBuddy 登录态（`workbuddy-desktop.info`），无需手动复制 token
- 通过 WebSocket 向 xrl-router 注册（V24 契约，无 `keys`），由 Router 统一做鉴权、路由、密钥轮转
- 模型目录在启动时从网关动态拉取，当前可注册 33 个文本模型

## 前置要求

- Node.js ≥ 20、pnpm
- WorkBuddy 已安装并处于登录状态
- xrl-router 已运行（默认 `http://localhost:19068`）

## 快速开始

```bash
pnpm install
cp .env.example .env   # 可选：默认值已能跑通
pnpm check-auth        # 验证登录态解密与网关连通性（不打印 token）
pnpm serve             # 启动插件，监听 19069 并连接 xrl-router
```

首次注册后，插件 provider 在 Router 中默认是 **disabled / pending** 状态，需要确认一次：

```bash
curl -X POST http://localhost:19068/api/plugins/plugin-workbuddy/confirm
```

或在 Router 的插件管理界面里点击启用。确认后 `/v1/models` 即可看到模型。

### 验证

```bash
curl http://127.0.0.1:19069/health

curl -s http://127.0.0.1:19069/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"glm-5.3","messages":[{"role":"user","content":"Say ok."}],"max_tokens":20}'

curl -sN http://127.0.0.1:19069/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"glm-5.3-flash","stream":true,"messages":[{"role":"user","content":"Say ok."}],"max_tokens":20}'
```

## 配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `WORKBUDDY_PORT` | `19069` | 插件 HTTP 端口 |
| `XRL_ROUTER_URL` | `http://localhost:19068` | xrl-router 地址（WS 自动换成 `ws://`） |
| `WORKBUDDY_BASE_URL` | `https://copilot.tencent.com` | WorkBuddy 网关 |
| `WORKBUDDY_DOMAIN` | `www.workbuddy.cn` | 请求头 `X-Domain` |
| `WORKBUDDY_IDE_VERSION` | `5.8.3` | 伪装客户端版本（`User-Agent` / `X-IDE-Version`） |
| `WORKBUDDY_AUTH_PATH` | 自动探测 | 登录态文件路径 |
| `WORKBUDDY_APP_PATH` | 自动探测 | WorkBuddy 可执行文件，仅用于读取 at-rest 密钥 |
| `WORKBUDDY_MODELS` | 空 | 逗号分隔的模型白名单；留空 = 拉取完整目录 |
| `WORKBUDDY_REFRESH_AHEAD_MS` | `300000` | access token 提前刷新窗口 |
| `WORKBUDDY_REQUEST_TIMEOUT_MS` | `600000` | 上游请求超时 |
| `WORKBUDDY_ACCESS_TOKEN` / `WORKBUDDY_REFRESH_TOKEN` / `WORKBUDDY_USER_ID` | 空 | 灾备凭证，auth 文件不可用时使用 |

登录态文件默认位置：

- Windows: `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info`
- macOS: `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info`

## 凭证与刷新

1. 从登录态文件读取 `auth.accessToken` / `auth.refreshToken`（AES-256-GCM 信封加密）
2. 通过 WorkBuddy 自带的 Electron binding 获取 at-rest secret，派生解密密钥
3. access token 临近过期时调用 `/v2/plugin/auth/token/refresh` 刷新
4. 刷新结果重新封装后原子写回登录态文件；WorkBuddy App 会监听该目录并热加载
5. 写回时复用原始信封 `keyId`（该值不可由密钥推导），否则 App 无法解密

## 模型注册

- 启动时从 `/v2/enterprises/personal/models` 拉取目录，过滤 `text-to-image` 模型
- 注册时 `display_name` 直接使用 `model_id`：上游目录中的展示名存在重复（如多个 `Hy3`），而 Router 以 `display_name` 作为客户端可调用的唯一别名
- 若需固定模型集合，设置 `WORKBUDDY_MODELS=auto,glm-5.3,kimi-k3-1` 等

## 协议行为

- 上游 `/v2/chat/completions` **只支持流式**，非流式请求会返回 `400 / code 11101`
- 插件向上游始终发 `stream:true`；客户端要非流式时，插件聚合 SSE 后返回标准 `chat.completion`
- 流式转发前会做分片归一化，以适配 xrl-router 的 Anthropic 转换：
  - `finish_reason: ""` → `null`（Router 把空串当作结束信号）
  - 剔除空的 `tool_calls: []`（Router 把空数组当作块边界，会提前关闭 thinking/text）
  - tool call 续传分片只带 `index + arguments`，首个分片才带 `id/name`
- 支持 `reasoning_content`、tool calls、usage 透传

## 脚本

| 命令 | 作用 |
|---|---|
| `pnpm serve` | 启动插件 |
| `pnpm check-auth` | 诊断登录态、解密、token 有效期、模型目录 |
| `pnpm refresh-token -- --yes` | 强制刷新 token 并写回（refresh token 会轮换，需显式确认） |
| `pnpm typecheck` | TypeScript 类型检查 |

## 故障排查

| 现象 | 处理 |
|---|---|
| Router 报 `Model not found or not available` | 用模型 ID 作为 `model`；确认 `plugin-workbuddy` 已 confirm/enabled |
| 插件启动后 Router 中模型不可用 | provider 初始为 disabled，执行一次 `/api/plugins/plugin-workbuddy/confirm` |
| 401 / token 失效 | 插件会自动刷新一次；仍失败时运行 `pnpm check-auth` 检查登录态 |
| 解密失败 | 确认 WorkBuddy 已登录、`WORKBUDDY_APP_PATH` 指向正确安装位置 |
| 端口被旧实例占用 | 启动时自动结束占用 `19069` 的旧进程（排除自身） |
| WorkBuddy 升级后请求异常 | 更新 `WORKBUDDY_IDE_VERSION`，必要时调整 `WORKBUDDY_BASE_URL` |

## 安全说明

- 插件只读取并使用**本机当前登录用户自己的**凭证，不要用于他人账号
- 日志与诊断脚本不打印 token 明文；`check-auth` 仅输出长度与有效期
- `.env` 已 gitignore，切勿提交任何凭证
- 刷新会轮换 refresh token，并写回 WorkBuddy 登录态文件

## 延伸阅读

- [AGENTS.md](./AGENTS.md) — 项目边界与 Agent 约定
- [docs/WORKBUDDY_REVERSE.md](./docs/WORKBUDDY_REVERSE.md) — 网关、凭证、SSE 逆向记录
