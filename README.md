# Microsoft OAuth2 Cloudflare Worker

配置存储在 **Cloudflare KV** 中，可通过网页 `/config` 页面管理。

## 功能页面

| 路径 | 功能 |
|------|------|
| `GET /` | 首页，显示授权按钮 |
| `GET /authorize` | 跳转到 Microsoft 登录页 |
| `GET /callback?code=xxx` | 用 code 换取 token，展示结果 |
| `GET /refresh?refresh_token=xxx` | 用 refresh_token 刷新 token |
| `GET /config` | 配置管理页面（设置 KV 中的 CLIENT_ID 等） |

## 部署步骤

### 1. 安装 Wrangler CLI

```bash
npm install -g wrangler
wrangler login
```

### 2. 创建 KV 命名空间

```bash
cd oauth-ms-worker
wrangler kv namespace create "CONFIG"
```

返回类似：`{ binding = "CONFIG", id = "xxxxxxxxxxxx" }`

### 3. 填入 KV namespace ID

把上一步返回的 `id` 填入 `wrangler.toml` 中的 `<创建 KV 后填入 namespace_id>`

### 4. 部署

```bash
wrangler deploy
```

### 5. 配置 KV

部署后有两种方式写入配置：

**方式 A：网页配置（推荐）**

访问 `https://<你的worker>.workers.dev/config`，填入三个值，点击保存。

**方式 B：命令行**

```bash
wrangler kv key put --binding CONFIG CLIENT_ID "9e5f94bc-e8a4-4e73-b8be-63364c29d753"
wrangler kv key put --binding CONFIG CLIENT_SECRET "你的 Client Secret"
wrangler kv key put --binding CONFIG REDIRECT_URI "https://<你的worker>.workers.dev/callback"
```

### 6. Azure AD 配置

在 Azure Portal → App registrations 中，Redirect URI 添加：

```
https://<你的worker>.workers.dev/callback
```

## 使用流程

```
用户浏览器
    │
    ├─ 访问 / → 首页（授权按钮）
    │
    ├─ 点击 /authorize → 302 → Microsoft 登录页
    │
    ├─ 用户登录 + 同意权限
    │   └─ 302 → /callback?code=xxx
    │
    └─ Worker 用 code 换 token
        └─ 页面展示 access_token / refresh_token
```
