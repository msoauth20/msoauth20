/**
 * Microsoft OAuth2 Proxy Worker for Cloudflare
 *
 * Microsoft OAuth2 授权工具（支持公开/机密客户端）
 *
 * 配置：
 *   CLIENT_ID    — 硬编码公共 Client ID，支持前端自定义
 *   REDIRECT_URI — http://localhost
 *
 * 流程：
 * 1. GET /          → 首页，点击授权按钮
 * 2. GET /authorize  → 跳转到 Microsoft 登录页（支持 ?client_id=xxx）
 * 3. GET /callback   → 授权后回调页面
 * 4. POST /callback  → 用 code 换 access_token（支持自定义凭据）
 * 5. GET /refresh    → 用 refresh_token 刷新 access_token
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
        return await handleAuthorize(request, env);
      }

      if (path === '/callback') {
        return await handleCallback(request, env);
      }

      if (path === '/refresh') {
        return await handleRefresh(url, env);
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
async function handleAuthorize(request, env) {
  // 支持 URL 参数传入 client_id，默认使用公共 Client ID
  const url = new URL(request.url);
  const clientId = url.searchParams.get('client_id') || '9e5f94bc-e8a4-4e73-b8be-63364c29d753';
  const redirectUri = 'http://localhost';

  // Mail.Read 和 Mail.Send 作为默认权限（不在页面显示）
  const scopes = [
    'offline_access',
    'https://graph.microsoft.com/Mail.Read',
    'https://graph.microsoft.com/Mail.Send',
  ];
  const scope = encodeURIComponent(scopes.join(' '));

  const authUrl =
    'https://login.microsoftonline.com/common/oauth2/v2.0/authorize' +
    '?client_id=' + encodeURIComponent(clientId) +
    '&response_type=code' +
    '&redirect_uri=' + encodeURIComponent(redirectUri) +
    '&response_mode=query' +
    '&scope=' + scope +
    '&prompt=consent';

  // 直接 302 跳转
  return Response.redirect(authUrl, 302);
}

// ─────────────────────────────────────────────
// 2. /callback — 用 code 换 token（支持 GET 和 POST）
// ─────────────────────────────────────────────
async function handleCallback(request, env) {
  let code = null;
  let error = null;

  // 支持 POST 请求（避免 URL 编码问题）
  let clientId, clientSecret;
  if (request.method === 'POST') {
    try {
      const body = await request.json();
      code = body.code ? decodeURIComponent(body.code) : null;
      clientId = body.client_id;
      clientSecret = body.client_secret;
    } catch (e) {
      return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }
  } else {
    // GET 请求
    const url = new URL(request.url);
    code = url.searchParams.get('code');
    error = url.searchParams.get('error');

    if (error) {
      return jsonResponse({
        error,
        error_description: url.searchParams.get('error_description'),
      }, 400);
    }
  }

  if (!code) {
    // GET 请求返回 HTML 页面
    if (request.method !== 'POST') {
      return new Response(renderHTML({ error: 'URL 中未找到 code 参数' }), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }
    return jsonResponse({ error: 'code is required', error_description: '请提供 Authorization Code' }, 400);
  }

  // 默认使用公共 Client ID，支持自定义
  clientId = clientId || '9e5f94bc-e8a4-4e73-b8be-63364c29d753';
  const redirectUri = 'http://localhost';
  const scopes = 'offline_access https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.Send';

  const tokenEndpoint =
    'https://login.microsoftonline.com/common/oauth2/v2.0/token';

  // 基础请求体（与 PowerShell 脚本一致，包含 scope）
  const body = new URLSearchParams({
    client_id: clientId,
    scope: scopes,
    code,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });

  // 仅机密客户端添加 client_secret
  if (clientSecret && clientSecret.trim() !== '') {
    body.set('client_secret', clientSecret);
  }

  const resp = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const tokenData = await resp.json();

  if (!resp.ok) {
    if (request.method === 'POST') {
      return jsonResponse({ 
        error: 'Token 交换失败', 
        error_description: tokenData.error_description || tokenData.error || '未知错误',
        details: tokenData 
      }, 400);
    }
    return new Response(renderHTML({ error: 'Token 交换失败', details: tokenData }), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  // POST 请求返回 JSON
  if (request.method === 'POST') {
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

  // GET 请求返回 HTML 页面
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

  // 支持自定义 client_id 和 client_secret
  const clientId = url.searchParams.get('client_id') || '9e5f94bc-e8a4-4e73-b8be-63364c29d753';
  const clientSecret = url.searchParams.get('client_secret') || '';

  const tokenEndpoint =
    'https://login.microsoftonline.com/common/oauth2/v2.0/token';

  const body = new URLSearchParams({
    client_id: clientId,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
    scope: 'offline_access https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.Send',
  });

  // 仅机密客户端添加 client_secret
  if (clientSecret && clientSecret.trim() !== '') {
    body.set('client_secret', clientSecret);
  }

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
    // 首页 —— 简化页面，只显示授权按钮
    contentHTML = `
      <div class="card">
        <h2>🔐 Microsoft OAuth2 授权</h2>
        
        <!-- 隐藏的权限说明（Mail.Read 和 Mail.Send 默认启用但不显示） -->
        <div class="scopes" style="display: none;">
          <div class="scope-item">📧 <code>Mail.Read</code> — 读取邮件</div>
          <div class="scope-item">✉️ <code>Mail.Send</code> — 发送邮件</div>
          <div class="scope-item">🔄 <code>offline_access</code> — 获取 Refresh Token</div>
        </div>
        
        <!-- 配置区域 -->
        <div style="margin-top: 20px; padding: 16px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 10px;">
          <details>
            <summary style="cursor: pointer; color: #888; font-size: 0.9em;">⚙️ 高级配置（自定义应用）</summary>
            <div style="margin-top: 12px;">
              <div class="field">
                <label style="color: #aaa; font-size: 0.9em;">Client ID（留空使用公共应用）</label>
                <input type="text" id="input-client-id" placeholder="9e5f94bc-e8a4-4e73-b8be-63364c29d753" />
              </div>
              <div class="field" style="margin-top: 10px;">
                <label style="color: #aaa; font-size: 0.9em;">Client Secret（公开客户端留空）</label>
                <input type="password" id="input-client-secret" placeholder="机密客户端填写，公开客户端留空" />
              </div>
            </div>
          </details>
        </div>

        <button class="btn" onclick="handleAuthorizeNewTab()" style="margin-top: 16px;">🚀 获取授权code（新标签页打开）</button>
        
        <!-- 手动输入 code 的区域 -->
        <div class="manual-section" style="margin-top: 24px; padding: 20px; background: rgba(102,126,234,0.1); border: 1px solid rgba(102,126,234,0.3); border-radius: 12px;">
          <h3 style="font-size: 1.1em; margin-bottom: 12px; color: #64b5f6;">📋 获取 Token</h3>
          <ol style="font-size: 0.9em; color: #aaa; margin-bottom: 16px; padding-left: 20px; line-height: 1.8;">
            <li>先在上方 ⚙️ 高级配置 填写你的 Client ID 和 Secret（机密客户端）</li>
            <li>点击上方按钮，新标签页打开 Microsoft 授权页面</li>
            <li>在新标签页输入 Microsoft 账号密码并完成授权</li>
            <li>浏览器会跳转到 <code style="color: #64b5f6;">http://localhost?code=xxx</code></li>
            <li>复制 URL 中的 <strong>code</strong> 参数值</li>
            <li>回到此页面，粘贴到下方输入框</li>
          </ol>
          <div class="field">
            <label style="color: #fff; font-size: 1em;">Authorization Code</label>
            <input type="text" id="manual-code" placeholder="粘贴从 localhost URL 中复制的 code" style="font-size: 1em; padding: 14px;" />
          </div>
          <button onclick="exchangeCode()" class="btn" style="margin-top: 12px; width: 100%;">🔄 交换获取 Token</button>
          <div id="manual-result"></div>
        </div>
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
    .account-section {
      margin: 24px 0;
      padding: 20px;
      background: rgba(255,255,255,0.05);
      border-radius: 12px;
      border: 1px solid rgba(255,255,255,0.1);
    }
    .field {
      margin-bottom: 16px;
    }
    .field:last-child {
      margin-bottom: 0;
    }
    .field label {
      display: block;
      font-weight: 600;
      font-size: 0.9em;
      color: #aaa;
      margin-bottom: 8px;
    }
    .field input[type="text"],
    .field input[type="password"] {
      width: 100%;
      padding: 12px 16px;
      background: rgba(0,0,0,0.3);
      border: 1px solid rgba(255,255,255,0.15);
      border-radius: 8px;
      color: #64b5f6;
      font-family: 'Fira Code', monospace;
      font-size: 0.95em;
      outline: none;
      transition: border 0.2s;
    }
    .field input[type="text"]:focus,
    .field input[type="password"]:focus {
      border-color: rgba(102,126,234,0.6);
    }
    .field input::placeholder {
      color: #555;
    }
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
    function escapeHTML(str) {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function handleAuthorizeNewTab() {
      // 读取自定义 client_id
      const customClientId = document.getElementById('input-client-id')?.value?.trim();
      let authorizeUrl = '/authorize';
      if (customClientId) {
        authorizeUrl += '?client_id=' + encodeURIComponent(customClientId);
      }
      // 在新标签页打开授权页面
      window.open(authorizeUrl, '_blank');
      
      // 聚焦到 code 输入框
      document.getElementById('manual-code').focus();
      document.getElementById('manual-code').placeholder = '请在新标签页完成授权，复制 code 粘贴到这里...';
    }
    
    // 页面加载时检查 URL 中是否有 code（从回调页面跳回的情况）
    window.addEventListener('DOMContentLoaded', function() {
      // 检查 URL 中是否有 code
      const urlParams = new URLSearchParams(window.location.search);
      const code = urlParams.get('code');
      if (code) {
        document.getElementById('manual-code').value = code;
        exchangeCode();
      }
    });
    
    async function exchangeCode() {
      const code = decodeURIComponent(document.getElementById('manual-code')?.value?.trim() || '');
      const el = document.getElementById('manual-result');
      
      if (!code) {
        el.textContent = '❌ 请输入 Authorization Code';
        el.style.color = '#ef9a9a';
        return;
      }
      
      el.textContent = '⏳ 正在交换 Token...';
      el.style.color = '#64b5f6';
      
      try {
        // 读取自定义凭据
        const customClientId = document.getElementById('input-client-id')?.value?.trim();
        const customClientSecret = document.getElementById('input-client-secret')?.value?.trim();
        
        // 使用 POST 请求发送 code，避免 URL 编码问题
        const postBody = { code: code };
        if (customClientId) postBody.client_id = customClientId;
        if (customClientSecret) postBody.client_secret = customClientSecret;
        
        const resp = await fetch('/callback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(postBody)
        });
        
        const data = await resp.json();
        
        // 检查是否有错误
        if (data.error) {
          el.textContent = '❌ ' + (data.error_description || data.error);
          el.style.color = '#ef9a9a';
          return;
        }
        
        // 显示 token 信息
        if (data.success && data.token) {
          const t = data.token;
          const accessToken = escapeHTML(t.access_token || '');
          const refreshToken = escapeHTML(t.refresh_token || '');
          const expiresIn = t.expires_in || '';
          const tokenType = t.token_type || '';
          const scope = t.scope || '';
          
          const resultHTML = 
            '<div style="margin-top: 16px; padding: 16px; background: rgba(76,175,80,0.1); border: 1px solid rgba(76,175,80,0.3); border-radius: 8px;">' +
              '<h4 style="color: #81c784; margin-bottom: 12px;">✅ Token 获取成功！</h4>' +
              '<div style="margin-bottom: 12px;">' +
                '<label style="display: block; font-weight: 600; margin-bottom: 4px; color: #aaa; font-size: 0.9em;">Access Token:</label>' +
                '<textarea readonly style="width: 100%; height: 60px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; color: #64b5f6; font-family: monospace; font-size: 0.8em; padding: 8px; resize: none;">' + accessToken + '</textarea>' +
              '</div>' +
              '<div style="margin-bottom: 12px;">' +
                '<label style="display: block; font-weight: 600; margin-bottom: 4px; color: #aaa; font-size: 0.9em;">Refresh Token:</label>' +
                '<textarea readonly style="width: 100%; height: 60px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; color: #64b5f6; font-family: monospace; font-size: 0.8em; padding: 8px; resize: none;">' + refreshToken + '</textarea>' +
              '</div>' +
              '<div style="display: flex; gap: 20px; flex-wrap: wrap; font-size: 0.9em; color: #999; margin: 8px 0;">' +
                '<span>⏱️ 有效期: <strong style="color: #e0e0e0;">' + expiresIn + 's</strong> (' + Math.round(expiresIn / 60) + ' 分钟)</span>' +
                '<span>🔑 类型: <strong style="color: #e0e0e0;">' + escapeHTML(tokenType) + '</strong></span>' +
              '</div>' +
              '<div style="font-size: 0.9em; color: #999; margin: 8px 0;">' +
                '<span>📎 权限范围: <code style="color: #64b5f6;">' + escapeHTML(scope) + '</code></span>' +
              '</div>' +
            '</div>';
          
          el.innerHTML = resultHTML;
        } else {
          el.textContent = '❌ 无法解析 Token 信息';
          el.style.color = '#ef9a9a';
        }
      } catch(e) {
        el.textContent = '❌ 请求失败: ' + e.message;
        el.style.color = '#ef9a9a';
      }
    }
    
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
          headers: { 'Authorization': '***' + token }
        });
        const data = await resp.json();
        if (!resp.ok) { el.textContent = '❌ API 错误: ' + JSON.stringify(data, null, 2); return; }
        if (!data.value?.length) { el.textContent = '📭 没有邮件'; return; }
        el.innerHTML = data.value.map((m, i) =>
          '\\n📬 ' + (i+1) + '. [' + m.from?.emailAddress?.address + '] ' + m.subject + '\\n   ' + m.receivedDateTime
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
