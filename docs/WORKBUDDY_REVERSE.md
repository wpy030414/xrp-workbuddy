# WorkBuddy 网关与凭证逆向记录

本文记录本插件依赖的 WorkBuddy（CodeBuddy）客户端行为与网关协议。仅用于本机、本人账号的互操作实验。

## 1. 网关端点

| 用途 | 方法与路径 | 说明 |
|---|---|---|
| 对话 | `POST https://copilot.tencent.com/v2/chat/completions` | **仅支持流式** |
| 模型目录 | `GET /v2/enterprises/personal/models` | 返回个人/企业可用模型 |
| Token 刷新 | `POST /v2/plugin/auth/token/refresh` | 插件模式刷新入口 |

备用域：`https://www.workbuddy.cn`。

非流式对话（`stream:false`）返回：

```
HTTP 400
{"code":11101, ...}
```

因此插件对上游始终使用 `stream:true`，客户端需要非流式时由插件聚合。

## 2. 客户端身份请求头

网关会校验一组客户端身份头，插件按桌面端格式发送（值可配置）：

```
Authorization: Bearer <accessToken>
X-User-Id: <uid>
X-Domain: www.workbuddy.cn
X-Product: SaaS
X-IDE-Type: WorkBuddy
X-IDE-Name: WorkBuddy
X-IDE-Version: 5.8.3
X-Private-Data: true
User-Agent: WorkBuddy/5.8.3
x-requested-with: XMLHttpRequest
X-Agent-Intent: craft
X-Agent-Purpose: conversation
x-codebuddy-request: 1
```

对话请求还会带会话级 ID 与链路头：

```
X-Conversation-ID
X-Conversation-Request-ID
X-Conversation-Message-ID
X-Request-ID
acp-connection-id
traceparent
```

## 3. 登录态文件

### 3.1 位置与结构

```
Windows: %LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info
macOS:   ~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info
```

顶层结构：

```json
{
  "auth": { "accessToken": {...}, "refreshToken": {...}, "expiresAt": 0, "refreshExpiresAt": 0, ... },
  "account": { "uid": "...", ... },
  "accounts": [],
  "allAccounts": []
}
```

`accessToken` / `refreshToken` 不是明文，而是字段级密文信封。

### 3.2 字段信封

```json
{
  "$wbEncrypted": 1,
  "envelope": "<base64(JSON{suite,keyId,nonce,authTag,ciphertext})>"
}
```

内部信封字段：

```json
{
  "suite": 1,
  "keyId": "<16 hex>",
  "nonce": "<base64, 12 bytes>",
  "authTag": "<base64, 16 bytes>",
  "ciphertext": "<base64>"
}
```

算法：AES-256-GCM，`authTagLength = 16`。

### 3.3 at-rest 主密钥

WorkBuddy 注册了自定义 Electron binding。以 NODE 模式运行 WorkBuddy 可读取：

```bash
ELECTRON_RUN_AS_NODE=1 "C:\Program Files\WorkBuddy\WorkBuddy.exe" \
  -e "process.stdout.write(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet())"
```

输出 JSON 中包含 `atRestSecretKey`。派生：

```
key = sha256(atRestSecretKey)
```

即 32 字节 AES key。

### 3.4 AAD 构造

AAD 为二进制拼接（`LP(x)` = 4 字节大端长度 + UTF-8 字节）：

```
"WB-AAD\0"          // 8 bytes, ascii
0x01                // version
LP("WBEV1")         // field magic
LP("sym-v1")        // scheme
u32(1)              // suite = AES-256-GCM
LP(keyId)           // 沿用信封中的 keyId
0x02                // framing = field
0x00
0x00
```

字段信封只使用上述 AAD，不需要额外拼接字段名。若 AAD 任一字节不匹配，GCM 校验失败。

### 3.5 keyId 陷阱

`keyId`（16 hex）**不能**由 `sha256(atRestSecretKey)` 推导。实验中将派生 key 的前 16 hex 作为 keyId 会导致 App 解密失败。

写回时必须复用原信封中的 `keyId`，只更换 nonce / authTag / ciphertext。

### 3.6 刷新与写回

刷新请求：

```
POST /v2/plugin/auth/token/refresh
X-Refresh-Token: <refreshToken>
X-Auth-Refresh-Source: plugin
X-Domain: www.workbuddy.cn
```

响应有效载荷位于 `data.data` 或 `data`，字段兼容：

- `accessToken` / `access_token`
- `refreshToken` / `refresh_token`
- `expiresAt` / `expiresIn`
- `refreshExpiresAt` / `refreshExpiresIn`

刷新后 refresh token 会轮换。插件将新 token 重新封装（保留 keyId）并原子写回登录态文件（临时文件 + rename）。

WorkBuddy App 对 auth 目录做了监听（`handleExternalChange → restore`），因此写回后 App 会自动拾取新登录态，避免双方刷新互踩。

## 4. 模型目录

`GET /v2/enterprises/personal/models` 返回模型数组，条目包含：

- `id`（真正用于对话的模型 ID）
- `name`（展示名，可能重复）
- `tags`（如 `text-to-image`）
- 上下文长度、能力等元数据

实验时目录 34 条，其中 `hunyuan-image-alpha` 带 `text-to-image` 标签，插件过滤后注册 33 个文本模型。

典型 ID：

```
auto, hy3, hy3-x, hy4-preview, hy4-preview-x, default,
glm-5v-turbo, glm-5.3, glm-5.3-flash, glm-5.2, glm-5.1, glm-5.0,
glm-4.7, glm-4.6, glm-4.6v,
minimax-m3, minimax-m2.5, minimax-m3.1-flash,
kimi-k3-1, kimi-k2.8-preview, kimi-k2.7, kimi-k2.6, kimi-k2.5, kimi-k2-thinking,
deepseek-v4-flash, deepseek-v4.1-flash, deepseek-v4-pro, deepseek-v3-2-volc,
hunyuan-2.0-thinking, hunyuan-chat, space-bunny, step-5-preview, mimo-v2.6-pro
```

展示名存在重复（例如 `Hy3` 与 `Hy3-X` 都叫 `Hy3`），而 xrl-router 以 `display_name` 作为路由键，因此插件注册时直接使用模型 ID 作为 `display_name`。

## 5. Chat Completions 流式协议

响应为 `text/event-stream`：

```
: heartbeat
data: {...chunk...}
data: {...chunk...}
data: [DONE]
```

chunk 是标准 OpenAI Chat Completions 结构，但 delta 带额外字段：

```json
{
  "id": "...",
  "model": "glm-5.3-flash",
  "object": "chat.completion.chunk",
  "choices": [{
    "index": 0,
    "delta": {
      "role": "assistant",
      "content": "",
      "reasoning_content": "Simple",
      "function_call": null,
      "refusal": "",
      "tool_calls": [],
      "extra_fields": null
    },
    "logprobs": null,
    "finish_reason": ""
  }],
  "usage": null
}
```

关键观察：

1. **普通分片也带 `finish_reason: ""`**，只有最终分片是 `"stop"` 等真实值
2. **每个分片都带 `tool_calls: []`**，即使没有工具调用
3. 最终分片常带 `function_call: {"name":"","arguments":""}`（空壳）
4. `reasoning_content` 与 `content` 可能先后出现；usage 只在末尾分片有值
5. 工具调用首个分片带 `id/type/function.name` 与空 `arguments`，续传分片 `name` 为空字符串、只带 `arguments` 片段

## 6. xrl-router 转换兼容

Router 把 `chat_completions` 插件的流转换为内部 IR，再渲染给 OpenAI / Anthropic 客户端。以下行为需要插件侧归一化：

| Router 行为 | 后果 | 插件处理 |
|---|---|---|
| 把 `finish_reason: ""` 当作结束信号 | 每个分片都关闭内容块 | 空串转 `null` |
| 把空 `tool_calls: []` 当作块边界 | thinking/text 块被反复关闭重建 | 删除空数组字段 |
| 把任何 `function.name`（含 `""`）当作新 tool_use 块 | Anthropic 出现多个空 tool_use | 仅首分片带 `id/name`，续传分片只带 `index/arguments` |

其他 Router 行为（插件无需处理，但排障时需要知道）：

- 客户端按 `display_name` 路由，不按 `model_id`
- 新注册 provider 初始 `enabled:false` / `pending`，需 `POST /api/plugins/:id/confirm`
- Router 向插件发送占位 Bearer，插件必须使用自身凭证访问上游

## 7. 实验与验证

本机验证链路：

```bash
pnpm check-auth
pnpm serve
# 另开终端：
# 1) 创建临时 service key
# 2) 调 /v1/chat/completions（流式文本）
# 3) 调 /v1/messages（文本 / thinking / tool_use）
# 4) 删除临时 key
```

已验证：

- 文本流式、非流式聚合
- Anthropic `/v1/messages` 文本与 thinking 块
- Anthropic tool_use：单个工具块、参数分片、`stop_reason: tool_use`
- OpenAI tool_calls 聚合与流式转发

## 8. 安全与边界

- 仅使用当前机器、当前登录用户自己的凭证
- 不记录、不打印 token / refresh token / at-rest secret 明文
- `.env` 不进入版本控制
- 刷新会轮换 refresh token 并写回 WorkBuddy 登录态文件，操作前应确认影响
