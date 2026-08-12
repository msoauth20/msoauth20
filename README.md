# Microsoft OAuth2 Cloudflare Worker

简化版 Microsoft OAuth2 授权工具。

## 功能

- 🔐 Microsoft OAuth2 授权
- 📧 Mail.Read / Mail.Send 权限（默认启用）
- 🔄 Token 交换和刷新
- ⚙️ 支持公开/机密客户端（自定义 Client ID 和 Secret）

## 使用方法

1. 访问 Worker 首页
2. （可选）展开 ⚙️ 高级配置，填写你的 Client ID 和 Secret
3. 点击「获取授权code」
4. 在 Microsoft 登录页完成授权
5. 复制 code 回到原页面
6. 点击「交换获取 Token」

## 部署

```bash
wrangler deploy
```

## 配置

- **公开客户端**：留空 Client ID 和 Secret，使用公共应用
- **机密客户端**：填写你自己的 Client ID 和 Secret

