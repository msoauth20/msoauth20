# Microsoft OAuth2 Cloudflare Worker

简化版 Microsoft OAuth2 授权工具。

## 功能

- 🔐 Microsoft OAuth2 授权
- 📧 Mail.Read / Mail.Send 权限（默认启用）
- 🔄 Token 交换和刷新

## 使用方法

1. 访问 Worker 首页
2. 点击"获取授权code（新标签页打开）"
3. 在新标签页完成 Microsoft 登录授权
4. 复制 code 回到原页面
5. 点击"交换获取 Token"

## 部署

```bash
wrangler deploy
```

## 配置

使用公共 Client ID，无需额外配置。
