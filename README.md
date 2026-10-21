# xrl-router-plugin-workbuddy

> WorkBuddy / CodeBuddy 通道的 xrl-router 插件 — 自包含网页登录（OAuth 式 state 握手），把官方网关包装成 OpenAI Chat Completions 兼容服务。

```
OpenAI / Anthropic 客户端 → xrl-router :19068 → 本插件 :19069 → copilot.tencent.com
```

## 这是什么？

- xrl-router 的 WorkBuddy 通道插件，纯转发 / 协议适配层
- **自包含登录**：走 WorkBuddy 官方的 state→浏览器→轮询换票流程，本机**不需要安装 WorkBuddy App** 也能反代
- 凭证本地静态加密存储（Windows 用 DPAPI，跨平台用 passphrase AES），不落明文、不进 git
- 通过 WebSocket 向 xrl-router 注册（V24 契约，无 `keys`），由 Router 统一做鉴权、路由、密钥轮转
- 模型目录在启动时从网关动态拉取，当前可注册 33 个文本模型

> 可选兼容：`WORKBUDDY_USE_LEGACY_APP=1` 时，插件会额外读取并解密本机 WorkBuddy App 的登录态文件（见 docs 第 3 节）。默认关闭。

## 前置要求

- Node.js ≥ 20、pnpm
- **不需要 WorkBuddy App**；只需要一个能用浏览器登录 WorkBuddy 的账号
- xrl-router 已运行（默认 `http://localhost:19068`）

## 快速开始

```bash
pnpm install
cp .env.example .env   # 可选：默认值已能跑通
pnpm login             # 网页登录：打印 authUrl 并自动开浏览器，登录后凭证加密落盘
pnpm check-auth        # 验证登录态与网关连通性（不打印 token）
pnpm serve             # 启动插件，监听 19069 并连接 xrl-router
```

`pnpm login` 会输出形如 `https://www.workbuddy.cn/login?platform=workbuddy&state=...` 的链接并尝试自动打开浏览器；用你平时登录 WorkBuddy 的方式（扫码 / 账密，由腾讯托管，插件不经手口令）完成即可。成功后 token 加密写入本地凭证文件，之后 `serve` 直接复用。

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
| `WORKBUDDY_BASE_URL` | `https://copilot.tencent.com` | 推理网关（对话 / 目录 / 刷新） |
| `WORKBUDDY_AUTH_BASE_URL` | `https://www.workbuddy.cn` | 登录网关（握手 / 换票；与推理网关共用同一 state 存储） |
| `WORKBUDDY_DOMAIN` | `www.workbuddy.cn` | 请求头 `X-Domain` |
| `WORKBUDDY_IDE_VERSION` | `5.8.3` | 伪装客户端版本（`User-Agent` / `X-IDE-Version`） |
| `WORKBUDDY_PLATFORM` | `workbuddy` | 登录握手 `platform` 参数 |
| `WORKBUDDY_CREDENTIAL_PATH` | 用户数据目录 | 自包含凭证文件（加密；不进 git） |
| `WORKBUDDY_STORE_MODE` | `auto` | 存储形态：`auto` / `dpapi` / `aes` / `plain` |
| `WORKBUDDY_AUTH_SECRET` | 空 | AES 模式 passphrase；设置后 `auto` 优先用 AES（跨平台可迁移） |
| `WORKBUDDY_AUTO_LOGIN` | `0` | 无登录态时服务是否自动弹浏览器登录；默认关闭，改用 `pnpm login` |
| `WORKBUDDY_USE_LEGACY_APP` | `0` | 开启后才读取/解密 WorkBuddy App 登录态（旧版兼容） |
| `WORKBUDDY_MODELS` | 空 | 逗号分隔的模型白名单；留空 = 拉取完整目录 |
| `WORKBUDDY_REFRESH_AHEAD_MS` | `300000` | access token 提前刷新窗口 |
| `WORKBUDDY_REQUEST_TIMEOUT_MS` | `600000` | 上游请求超时 |
| `WORKBUDDY_ACCESS_TOKEN` / `WORKBUDDY_REFRESH_TOKEN` / `WORKBUDDY_USER_ID` | 空 | 灾备凭证，无任何登录态时使用 |

## 登录与凭证

1. `pnpm login` 发起 state 握手 → 浏览器登录 → 轮询换票（`code:11217` 表示仍在登录）→ 取账号
2. access / refresh token 经 DPAPI（Windows，绑定本机本用户）或 passphrase AES-256-GCM 加密，原子写入 `WORKBUDDY_CREDENTIAL_PATH`
3. 运行时 token 获取顺序：**内存缓存 → 本地凭证存储 → refresh 续期 →（默认不触发登录，提示 `pnpm login`）**
4. refresh token 会轮换，续期结果加密写回本地凭证文件
5. 服务态默认**不静默弹浏览器**：需要无人值守自动登录时设 `WORKBUDDY_AUTO_LOGIN=1`

存储形态选择（`WORKBUDDY_STORE_MODE=auto`）：Windows 用 DPAPI；设了 `WORKBUDDY_AUTH_SECRET` 则用 AES（可跨机迁移）；两者都没有时明文落盘并告警（文件权限 0600，仅建议临时用）。

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
| `pnpm login` | 网页登录，加密落盘自包含凭证 |
| `pnpm serve` | 启动插件 |
| `pnpm check-auth` | 诊断登录态、token 有效期、模型目录（不打印 token） |
| `pnpm refresh-token -- --yes` | 强制用 refresh token 续期并写回（refresh token 会轮换，需显式确认） |
| `pnpm typecheck` | TypeScript 类型检查 |

## 故障排查

| 现象 | 处理 |
|---|---|
| Router 报 `Model not found or not available` | 用模型 ID 作为 `model`；确认 `plugin-workbuddy` 已 confirm/enabled |
| 插件启动后 Router 中模型不可用 | provider 初始为 disabled，执行一次 `/api/plugins/plugin-workbuddy/confirm` |
| `pnpm serve` 提示无有效登录态 | 运行 `pnpm login` 完成网页登录，或设 `WORKBUDDY_AUTO_LOGIN=1` |
| 401 / token 失效 | 插件会自动用 refresh token 续期；仍失败时运行 `pnpm login` 重新登录 |
| 换票超时 / 登录没反应 | 确认 `authUrl` 打开后真的登录成功；`WORKBUDDY_LOGIN_TIMEOUT_MS` 可调超时 |
| 换到别的机器 / 用户凭证解不开 | DPAPI 绑定本机本用户；需迁移就用 `WORKBUDDY_STORE_MODE=aes` + `WORKBUDDY_AUTH_SECRET` |
| 端口被旧实例占用 | 启动时自动结束占用 `19069` 的旧进程（排除自身） |
| WorkBuddy 升级后请求异常 | 更新 `WORKBUDDY_IDE_VERSION`，必要时调整 `WORKBUDDY_BASE_URL` |

## 安全说明

- 插件只登录并使用**训练员本人**的 WorkBuddy 账号，不抓取、不复用他人凭证
- 登录页由腾讯托管，插件不经手账号密码，只发起 state 并轮询取回 token
- 凭证静态加密（DPAPI / AES）落盘；日志与诊断脚本不打印 token 明文，`check-auth` 仅输出长度与有效期
- `.env` 与凭证文件均已 gitignore，切勿提交任何密钥
- refresh 会轮换 refresh token，写回本地凭证文件

## 延伸阅读

- [AGENTS.md](./AGENTS.md) — 项目边界与 Agent 约定
- [docs/WORKBUDDY_REVERSE.md](./docs/WORKBUDDY_REVERSE.md) — 网关、自包含登录、凭证存储、SSE 逆向记录
