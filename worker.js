/**
 * Microsoft OAuth2 Proxy Worker for Cloudflare
 *
 * 配置存储在 KV（绑定名 CONFIG）中：
 *   CLIENT_ID     — Azure AD 应用的 Application (client) ID
 *   CLIENT_SECRET — Azure AD 应用的 Client Secret
 *   REDIRECT_URI  — 回调地址，格式：https://<your-worker>.workers.dev/callback
 *
 * 流程：
 * 1. GET /          → 首页，点击授权按钮
 * 2. GET /authorize  → 跳转到 Microsoft 登录页
 * 3. GET /callback   → 用 code 换 access_token，展示结果
 * 4. GET /refresh    → 用 refresh_token 刷新 access_token
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // ── 路由 ──
      if (path === '/' || path === '/index.html') {
        return new Response(renderHTML(null), {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }

      if (path === '/authorize') {
        return await handleAuthorize(env);
      }

      if (path === '/callback') {
        return await handleCallback(url, env);
      }

      if (path === '/refresh') {
        return await handleRefresh(url, env);
      }

      if (path === '/config') {
        return await handleConfig(request, env);
      }

      return new Response('Not Found', { status: 404 });
    } catch (err) {
      return new Response(renderHTML({ error: err.message }), {
        status: 500,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }
  },
};

// ─────────────────────────────────────────────
// 1. /authorize — 跳转到 Microsoft 登录
// ─────────────────────────────────────────────
async function handleAuthorize(env) {
  const clientId = await env.CONFIG.get('CLIENT_ID');
  const redirectUri = encodeURIComponent(await env.CONFIG.get('REDIRECT_URI'));

  const scopes = [
    'offline_access',
    'https://graph.microsoft.com/Mail.Read',
    'https://graph.microsoft.com/Mail.Send',
  ];
  const scope = encodeURIComponent(scopes.join(' '));

  const authUrl =
    `https://login.microsoftonline.com/common/oauth2/v2.0/authorize` +
    `?client_id=${clientId}` +
    `&response_type=code` +
    `&redirect_uri=${redirectUri}` +
    `&response_mode=query` +
    `&scope=${scope}` +
    `&prompt=consent`;

  // 直接 302 跳转
  return Response.redirect(authUrl, 302);
}

// ─────────────────────────────────────────────
// 2. /callback — 用 code 换 token
// ─────────────────────────────────────────────
async function handleCallback(url, env) {
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    return jsonResponse({
      error,
      error_description: url.searchParams.get('error_description'),
    }, 400);
  }

  if (!code) {
    return new Response(renderHTML({ error: 'URL 中未找到 code 参数' }), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  const clientId = await env.CONFIG.get('CLIENT_ID');
  const clientSecret = await env.CONFIG.get('CLIENT_SECRET');
  const redirectUri = await env.CONFIG.get('REDIRECT_URI');

  const tokenEndpoint =
    'https://login.microsoftonline.com/common/oauth2/v2.0/token';

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });

  const resp = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const tokenData = await resp.json();

  if (!resp.ok) {
    return new Response(renderHTML({ error: 'Token 交换失败', details: tokenData }), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  // 返回带 token 的 HTML 页面
  return new Response(renderHTML({
    success: true,
    token: {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_in: tokenData.expires_in,
      token_type: tokenData.token_type,
      scope: tokenData.scope,
    },
  }), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

// ─────────────────────────────────────────────
// 3. /refresh — 用 refresh_token 刷新 access_token
// ─────────────────────────────────────────────
async function handleRefresh(url, env) {
  const refreshToken = url.searchParams.get('refresh_token');
  if (!refreshToken) {
    return jsonResponse({ error: 'missing_refresh_token' }, 400);
  }

  const clientId = await env.CONFIG.get('CLIENT_ID');
  const clientSecret = await env.CONFIG.get('CLIENT_SECRET');

  const tokenEndpoint =
    'https://login.microsoftonline.com/common/oauth2/v2.0/token';

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
    scope: 'offline_access https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.Send',
  });

  const resp = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const tokenData = await resp.json();

  if (!resp.ok) {
    return jsonResponse({ error: 'refresh_failed', details: tokenData }, resp.status);
  }

  return jsonResponse({
    success: true,
    token: {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_in: tokenData.expires_in,
      token_type: tokenData.token_type,
      scope: tokenData.scope,
    },
  });
}

// ─────────────────────────────────────────────
// 4. /config — 管理 KV 配置（GET 显示表单，POST 保存）
// ─────────────────────────────────────────────
async function handleConfig(request, env) {
  if (request.method === 'POST') {
    const form = await request.formData();
    const clientId = form.get('client_id')?.trim();
    const clientSecret = form.get('client_secret')?.trim();
    const redirectUri = form.get('redirect_uri')?.trim();

    if (!clientId || !clientSecret || !redirectUri) {
      return new Response(renderConfigPage(env, '❌ 三个字段都必须填写', 'error'), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    await env.CONFIG.put('CLIENT_ID', clientId);
    await env.CONFIG.put('CLIENT_SECRET', clientSecret);
    await env.CONFIG.put('REDIRECT_URI', redirectUri);

    return new Response(renderConfigPage(env, '✅ 配置已保存到 KV！', 'success'), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  // GET — 显示配置表单
  return new Response(renderConfigPage(env), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function renderConfigPage(env, msg, msgType) {
  // 读取当前值（用于显示，secret 脱敏）
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>配置管理 - Microsoft OAuth2</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #1a1a2e, #16213e, #0f3460);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container { max-width: 560px; width: 100%; }
    .card {
      background: rgba(255,255,255,0.06);
      backdrop-filter: blur(20px);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 16px;
      padding: 36px;
      color: #e0e0e0;
    }
    h2 { font-size: 1.4em; margin-bottom: 8px; color: #fff; }
    .subtitle { color: #888; font-size: 0.9em; margin-bottom: 24px; }
    .field { margin-bottom: 20px; }
    label {
      display: block;
      font-weight: 600;
      font-size: 0.9em;
      color: #aaa;
      margin-bottom: 6px;
    }
    input[type="text"] {
      width: 100%;
      padding: 10px 14px;
      background: rgba(0,0,0,0.3);
      border: 1px solid rgba(255,255,255,0.15);
      border-radius: 8px;
      color: #64b5f6;
      font-family: 'Fira Code', monospace;
      font-size: 0.9em;
      outline: none;
      transition: border 0.2s;
    }
    input[type="text"]:focus { border-color: rgba(102,126,234,0.6); }
    .hint { font-size: 0.8em; color: #666; margin-top: 4px; }
    .btn {
      display: inline-block;
      padding: 12px 28px;
      background: linear-gradient(135deg, #667eea, #764ba2);
      color: #fff;
      border: none;
      border-radius: 10px;
      font-size: 1em;
      font-weight: 600;
      cursor: pointer;
      text-decoration: none;
      transition: all 0.2s;
      margin-top: 8px;
    }
    .btn:hover { transform: translateY(-1px); box-shadow: 0 6px 20px rgba(102,126,234,0.4); }
    .btn.secondary {
      background: rgba(255,255,255,0.1);
      border: 1px solid rgba(255,255,255,0.2);
      margin-left: 10px;
    }
    .msg {
      padding: 12px 16px;
      border-radius: 8px;
      margin-bottom: 20px;
      font-size: 0.95em;
    }
    .msg.success { background: rgba(76,175,80,0.15); border: 1px solid rgba(76,175,80,0.3); color: #81c784; }
    .msg.error { background: rgba(244,67,54,0.15); border: 1px solid rgba(244,67,54,0.3); color: #ef9a9a; }
    .actions { margin-top: 24px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <h2>⚙️ KV 配置管理</h2>
      <p class="subtitle">配置存储在 Cloudflare KV（绑定名 CONFIG）中</p>
      ${msg ? `<div class="msg ${msgType}">${msg}</div>` : ''}
      <form method="POST">
        <div class="field">
          <label>CLIENT_ID</label>
          <input type="text" name="client_id" placeholder="9e5f94bc-e8a4-4e73-b8be-63364c29d753" required />
          <div class="hint">Azure AD 应用的 Application (client) ID</div>
        </div>
        <div class="field">
          <label>CLIENT_SECRET</label>
          <input type="text" name="client_secret" placeholder="你的 Client Secret" required />
          <div class="hint">Azure AD 应用的 Client Secret Value</div>
        </div>
        <div class="field">
          <label>REDIRECT_URI</label>
          <input type="text" name="redirect_uri" placeholder="https://ms-oauth-worker.xxx.workers.dev/callback" required />
          <div class="hint">回调地址，必须与 Azure AD 中配置的一致</div>
        </div>
        <div class="actions">
          <button type="submit" class="btn">💾 保存到 KV</button>
          <a href="/" class="btn secondary">← 返回首页</a>
        </div>
      </form>
    </div>
  </div>
</body>
</html>`;
}

// ─────────────────────────────────────────────
// Helper: JSON 响应
// ─────────────────────────────────────────────
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

// ─────────────────────────────────────────────
// Helper: 渲染 HTML 页面
// ─────────────────────────────────────────────
function renderHTML(result) {
  let contentHTML = '';

  if (!result) {
    // 首页 —— 显示授权按钮
    contentHTML = `
      <div class="card">
        <h2>🔐 Microsoft OAuth2 授权</h2>
        <p>点击下方按钮，登录 Microsoft 账号并授权访问邮箱。</p>
        <div class="scopes">
          <div class="scope-item">📧 <code>Mail.Read</code> — 读取邮件</div>
          <div class="scope-item">✉️ <code>Mail.Send</code> — 发送邮件</div>
          <div class="scope-item">🔄 <code>offline_access</code> — 获取 Refresh Token</div>
        </div>
        <a href="/authorize" class="btn">🚀 开始授权</a>
      </div>`;
  } else if (result.error) {
    // 错误页
    contentHTML = `
      <div class="card error">
        <h2>❌ 出错了</h2>
        <p class="error-msg">${escapeHTML(result.error)}</p>
        ${result.details ? `<pre>${escapeHTML(JSON.stringify(result.details, null, 2))}</pre>` : ''}
        <a href="/" class="btn">← 返回重试</a>
      </div>`;
  } else if (result.success && result.token) {
    // 成功页 —— 显示 token
    const t = result.token;
    contentHTML = `
      <div class="card success">
        <h2>✅ Token 获取成功！</h2>
        <div class="token-section">
          <div class="token-block">
            <label>Access Token <button onclick="copyToken('access')" class="copy-btn">📋 复制</button></label>
            <textarea id="access-token" readonly>${escapeHTML(t.access_token)}</textarea>
          </div>
          <div class="token-block">
            <label>Refresh Token <button onclick="copyToken('refresh')" class="copy-btn">📋 复制</button></label>
            <textarea id="refresh-token" readonly>${escapeHTML(t.refresh_token)}</textarea>
          </div>
          <div class="meta">
            <span>⏱️ 有效期: <strong>${t.expires_in}s</strong> (${Math.round(t.expires_in / 60)} 分钟)</span>
            <span>🔑 类型: <strong>${escapeHTML(t.token_type)}</strong></span>
          </div>
          <div class="meta">
            <span>📎 权限范围: <code>${escapeHTML(t.scope)}</code></span>
          </div>
        </div>
        <div class="warn">
          ⚠️ 请立即保存 Refresh Token！关闭页面后无法再次查看。
        </div>
        <div class="actions">
          <a href="/" class="btn secondary">← 返回首页</a>
          <button onclick="testGraphAPI()" class="btn">📬 测试: 读取最新邮件</button>
        </div>
        <div id="api-result"></div>
      </div>`;
  }

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Microsoft OAuth2</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #0f0c29, #302b63, #24243e);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container { max-width: 640px; width: 100%; }
    .card {
      background: rgba(255,255,255,0.05);
      backdrop-filter: blur(20px);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 16px;
      padding: 40px;
      color: #e0e0e0;
    }
    .card.success { border-color: rgba(76,175,80,0.3); }
    .card.error { border-color: rgba(244,67,54,0.3); }
    h2 { font-size: 1.5em; margin-bottom: 16px; color: #fff; }
    p { margin-bottom: 16px; line-height: 1.6; }
    .scopes { margin: 20px 0; }
    .scope-item {
      padding: 10px 14px;
      margin: 6px 0;
      background: rgba(255,255,255,0.05);
      border-radius: 8px;
      font-size: 0.95em;
    }
    .scope-item code { color: #64b5f6; font-weight: 600; }
    .btn {
      display: inline-block;
      padding: 12px 28px;
      background: linear-gradient(135deg, #667eea, #764ba2);
      color: #fff;
      border: none;
      border-radius: 10px;
      font-size: 1em;
      font-weight: 600;
      cursor: pointer;
      text-decoration: none;
      transition: all 0.2s;
      margin-top: 8px;
    }
    .btn:hover { transform: translateY(-1px); box-shadow: 0 6px 20px rgba(102,126,234,0.4); }
    .btn.secondary {
      background: rgba(255,255,255,0.1);
      border: 1px solid rgba(255,255,255,0.2);
    }
    .btn.secondary:hover { background: rgba(255,255,255,0.15); box-shadow: none; }
    .copy-btn {
      padding: 4px 10px;
      font-size: 0.8em;
      background: rgba(255,255,255,0.1);
      border: 1px solid rgba(255,255,255,0.2);
      color: #ccc;
      border-radius: 6px;
      cursor: pointer;
      margin-left: 8px;
    }
    .copy-btn:hover { background: rgba(255,255,255,0.2); }
    .token-section { margin: 20px 0; }
    .token-block { margin-bottom: 16px; }
    .token-block label {
      display: flex;
      align-items: center;
      font-weight: 600;
      margin-bottom: 6px;
      color: #aaa;
      font-size: 0.9em;
    }
    textarea {
      width: 100%;
      height: 80px;
      background: rgba(0,0,0,0.3);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 8px;
      color: #64b5f6;
      font-family: 'Fira Code', monospace;
      font-size: 0.82em;
      padding: 10px;
      resize: none;
      word-break: break-all;
    }
    .meta {
      display: flex;
      gap: 20px;
      flex-wrap: wrap;
      font-size: 0.9em;
      color: #999;
      margin: 8px 0;
    }
    .meta code { color: #64b5f6; }
    .meta strong { color: #e0e0e0; }
    .warn {
      background: rgba(255,152,0,0.1);
      border: 1px solid rgba(255,152,0,0.3);
      border-radius: 8px;
      padding: 12px 16px;
      font-size: 0.9em;
      color: #ffb74d;
      margin: 20px 0;
    }
    .error-msg {
      background: rgba(244,67,54,0.1);
      padding: 12px;
      border-radius: 8px;
      color: #ef9a9a;
      font-family: monospace;
    }
    pre {
      background: rgba(0,0,0,0.3);
      padding: 12px;
      border-radius: 8px;
      font-size: 0.82em;
      overflow-x: auto;
      color: #ccc;
      margin: 12px 0;
    }
    .actions { display: flex; gap: 10px; flex-wrap: wrap; }
    #api-result {
      margin-top: 16px;
      white-space: pre-wrap;
      font-family: monospace;
      font-size: 0.85em;
      color: #aaa;
    }
  </style>
</head>
<body>
  <div class="container">${contentHTML}</div>
  <script>
    function copyToken(type) {
      const el = document.getElementById(type + '-token');
      if (!el) return;
      navigator.clipboard.writeText(el.value).then(() => {
        const btn = el.previousElementSibling?.querySelector('.copy-btn');
        if (btn) { btn.textContent = '✅ 已复制'; setTimeout(() => btn.textContent = '📋 复制', 1500); }
      });
    }
    async function testGraphAPI() {
      const el = document.getElementById('api-result');
      const token = document.getElementById('access-token')?.value;
      if (!token) { el.textContent = '❌ 未找到 access_token'; return; }
      el.textContent = '⏳ 请求 Graph API 中...';
      try {
        const resp = await fetch('https://graph.microsoft.com/v1.0/me/messages?$top=3&$select=subject,from,receivedDateTime', {
          headers: { 'Authorization': 'Bearer ' + token }
        });
        const data = await resp.json();
        if (!resp.ok) { el.textContent = '❌ API 错误: ' + JSON.stringify(data, null, 2); return; }
        if (!data.value?.length) { el.textContent = '📭 没有邮件'; return; }
        el.innerHTML = data.value.map((m, i) =>
          '\n📬 ' + (i+1) + '. [' + m.from?.emailAddress?.address + '] ' + m.subject + '\n   ' + m.receivedDateTime
        ).join('');
      } catch(e) { el.textContent = '❌ 请求失败: ' + e.message; }
    }
  </script>
</body>
</html>`;
}

function escapeHTML(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
