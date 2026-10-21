const AUTH_ORIGIN = 'https://auth.vertflux.com'
const COOKIE_NAME = '__Host-vertflux_sso'

export function authCookies(request) {
  return (request.headers.get('Cookie') || '').split(';')
    .map((part) => part.trim())
    .filter((part) => part.split('=')[0].startsWith(COOKIE_NAME))
    .join('; ')
}

function privateResponse(response) {
  const result = new Response(response.body, response)
  result.headers.set('Cache-Control', 'private, no-store')
  result.headers.set('Vary', 'Cookie')
  result.headers.set('Referrer-Policy', 'no-referrer')
  return result
}

function errorResponse(status, message) {
  return privateResponse(Response.json({ error: message }, { status }))
}

export function createAuthGateway({ host, binding, managementOnly = false, siteTokenBinding }) {
  // 成功会话仅在当前实例内缓存 15 秒，退出时删除 Cookie 即可立即失去访问权限。
  const sessions = new Map()
  const origin = `https://${host}`

  return {
    async fetch(request, env) {
      const url = new URL(request.url)
      let path
      try {
        path = decodeURIComponent(url.pathname).replace(/\/{2,}/g, '/')
      } catch {
        return errorResponse(400, '请求路径无效。')
      }
      if (url.hostname !== host || url.protocol !== 'https:') {
        if (!['GET', 'HEAD'].includes(request.method))
          return errorResponse(403, '请使用应用的正式域名。')
        return privateResponse(Response.redirect(`${origin}${url.pathname}${url.search}`, 302))
      }

      if (url.pathname.startsWith('/oauth2/')) {
        if (!['/oauth2/start', '/oauth2/callback', '/oauth2/sign_out'].includes(url.pathname))
          return errorResponse(404, '入口不存在。')
        if (!['GET', 'HEAD'].includes(request.method))
          return errorResponse(405, '登录入口仅接受 GET 请求。')
        const redirect = url.searchParams.get('rd')
        try {
          if (redirect && new URL(redirect, origin).origin !== origin)
            return errorResponse(400, '登录后的返回地址必须属于当前应用。')
        } catch {
          return errorResponse(400, '登录后的返回地址无效。')
        }
        const target = new URL(`/edge/${host.split('.')[0]}${url.pathname}${url.search}`, AUTH_ORIGIN)
        const headers = new Headers({ Cookie: authCookies(request), Accept: 'text/html' })
        try {
          return privateResponse(await fetch(target, { headers, redirect: 'manual', signal: AbortSignal.timeout(15000) }))
        } catch {
          return errorResponse(503, '统一认证暂时不可用，请稍后再试。')
        }
      }

      if (url.pathname === '/signed-out') {
        return privateResponse(new Response(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Vertflux</title><body><h1>已退出当前应用</h1><p><a href="${managementOnly ? '/dashboard' : '/'}">重新登录</a> · <a href="https://sso.vertflux.com/">账户中心</a></p></body></html>`, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        }))
      }

      // 更新已有的离线缓存，避免旧 Service Worker 在退出后显示缓存工作台。
      if (!managementOnly && url.pathname === '/sw.js') {
        return privateResponse(new Response("self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(k=>Promise.all(k.map(x=>caches.delete(x)))).then(()=>self.clients.claim()).then(()=>self.registration.unregister())));", {
          headers: { 'Content-Type': 'application/javascript; charset=utf-8' },
        }))
      }

      const protectedPath = !managementOnly || /^\/(dashboard|api|_docs)(\/|$)/.test(path)
      let identity
      if (protectedPath) {
        if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.get('Origin') !== origin)
          return errorResponse(403, '当前操作必须从应用页面发起。')
        const cookies = authCookies(request)
        if (cookies) {
          const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(cookies))
          const key = Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, '0')).join('')
          const cached = sessions.get(key)
          if (cached && cached.expires > Date.now()) {
            identity = cached.identity
          } else {
            try {
              const response = await fetch(`${AUTH_ORIGIN}/api/session?app=${encodeURIComponent(host)}`, {
                headers: { Cookie: cookies, Accept: 'application/json' },
                redirect: 'manual', signal: AbortSignal.timeout(15000),
              })
              if (response.status === 403)
                return errorResponse(403, '当前账号没有访问该应用的权限。')
              if (response.ok) {
                const session = await response.json()
                if (typeof session.username !== 'string' || !session.username || typeof session.subject !== 'string' || !session.subject)
                  return errorResponse(503, '统一认证返回的身份信息不完整。')
                identity = session
                if (sessions.size >= 256) sessions.delete(sessions.keys().next().value)
                sessions.set(key, { identity, expires: Date.now() + 15000 })
              } else if (response.status !== 401) {
                return errorResponse(503, '统一认证暂时不可用，请稍后再试。')
              }
            } catch {
              return errorResponse(503, '统一认证暂时不可用，请稍后再试。')
            }
          }
        }
        if (!identity) {
          const login = `/oauth2/start?rd=${encodeURIComponent(url.href)}`
          if (path.startsWith('/api/') || !['GET', 'HEAD'].includes(request.method) || request.headers.get('Accept')?.includes('application/json'))
            return privateResponse(Response.json({ error: '请先登录。', loginUrl: login }, { status: 401 }))
          return privateResponse(Response.redirect(`${origin}${login}`, 302))
        }
      }

      const headers = new Headers(request.headers)
      for (const name of [...headers.keys()]) {
        if (/^(x-vertflux-|x-auth-request-|x-forwarded-(user|subject|email|groups|preferred-username)|x-user$|x-email$|remote-user$|cf-access-)/i.test(name))
          headers.delete(name)
      }
      const businessCookies = (headers.get('Cookie') || '').split(';')
        .map((part) => part.trim()).filter((part) => part && !part.split('=')[0].startsWith(COOKIE_NAME)).join('; ')
      if (businessCookies) headers.set('Cookie', businessCookies)
      else headers.delete('Cookie')

      if (identity && siteTokenBinding && path.startsWith('/api/')) {
        if (!env[siteTokenBinding]) return errorResponse(503, '应用的内部认证尚未配置。')
        headers.set('Authorization', `Bearer ${env[siteTokenBinding]}`)
        headers.set('X-Vertflux-Subject', identity.subject)
        headers.set('X-Vertflux-Username', identity.username)
        headers.set('X-Vertflux-Email', identity.email || '')
      }
      const upstream = binding ? env[binding] : env.ASSETS
      const response = await upstream.fetch(new Request(request, { headers }))
      return protectedPath ? privateResponse(response) : response
    },
  }
}
