import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAuthGateway } from './site/_auth.mjs'

const options = { host: 'go.vertflux.com', binding: 'SINK_APP', managementOnly: true, siteTokenBinding: 'SINK_SITE_TOKEN' }
const identity = { subject: 'test-subject', username: 'test-user', email: 'test@example.com' }

test('统一认证入口的访问边界', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  let calls = 0
  let forwarded
  const env = {
    SINK_SITE_TOKEN: 'test-internal-token',
    SINK_APP: { fetch: async (request) => { calls++; forwarded = request; return new Response('application') } },
  }

  await t.test('未登录后台跳转登录，API 拒绝访问，伪造身份头无效', async () => {
    const app = createAuthGateway(options)
    const page = await app.fetch(new Request('https://go.vertflux.com/dashboard', { headers: { 'X-Vertflux-Subject': identity.subject } }), env)
    assert.equal(page.status, 302)
    assert.match(page.headers.get('Location'), /^https:\/\/go\.vertflux\.com\/oauth2\/start\?rd=/)
    const api = await app.fetch(new Request('https://go.vertflux.com/api/verify'), env)
    assert.equal(api.status, 401)
    assert.equal(calls, 0)
    const encoded = await app.fetch(new Request('https://go.vertflux.com/%61pi/verify'), env)
    assert.equal(encoded.status, 401)
  })

  await t.test('短链接保持公开，转发前清除伪造身份头', async () => {
    const app = createAuthGateway(options)
    const response = await app.fetch(new Request('https://go.vertflux.com/home', { headers: { 'X-Vertflux-Subject': 'forged' } }), env)
    assert.equal(response.status, 200)
    assert.equal(forwarded.headers.get('X-Vertflux-Subject'), null)
  })

  await t.test('默认域名只能跳转正式域名，不能直接访问后台', async () => {
    const app = createAuthGateway(options)
    const response = await app.fetch(new Request('https://vertflux-go.pages.dev/api/verify'), env)
    assert.equal(response.status, 302)
    assert.equal(response.headers.get('Location'), 'https://go.vertflux.com/api/verify')
  })

  await t.test('有效 SSO 会话转换成内部认证，Cookie 不转发给业务应用', async () => {
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), 'https://auth.vertflux.com/api/session?app=go.vertflux.com')
      assert.equal(init.headers.Cookie, '__Host-vertflux_sso=test')
      return Response.json(identity)
    }
    const app = createAuthGateway(options)
    const response = await app.fetch(new Request('https://go.vertflux.com/api/verify', { headers: {
      Cookie: '__Host-vertflux_sso=test; preference=zh', Authorization: 'Bearer forged', 'X-Vertflux-Subject': 'forged',
    } }), env)
    assert.equal(response.status, 200)
    assert.equal(forwarded.headers.get('Authorization'), 'Bearer test-internal-token')
    assert.equal(forwarded.headers.get('X-Vertflux-Subject'), identity.subject)
    assert.equal(forwarded.headers.get('Cookie'), 'preference=zh')
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
    assert.equal(await response.text(), 'application')
  })

  await t.test('认证不可用时拒绝访问，不放行业务请求', async () => {
    globalThis.fetch = async () => { throw new Error('offline') }
    const before = calls
    const app = createAuthGateway(options)
    const response = await app.fetch(new Request('https://go.vertflux.com/api/verify', { headers: { Cookie: '__Host-vertflux_sso=invalid' } }), env)
    assert.equal(response.status, 503)
    assert.equal(calls, before)
  })

  await t.test('登录但无应用权限时返回 403', async () => {
    globalThis.fetch = async () => new Response('', { status: 403 })
    const app = createAuthGateway(options)
    const response = await app.fetch(new Request('https://go.vertflux.com/dashboard', { headers: { Cookie: '__Host-vertflux_sso=denied' } }), env)
    assert.equal(response.status, 403)
  })

  await t.test('跨站写入请求被拒绝', async () => {
    const before = calls
    const app = createAuthGateway(options)
    const response = await app.fetch(new Request('https://go.vertflux.com/api/link/create', {
      method: 'POST', headers: { Origin: 'https://other.example', Cookie: '__Host-vertflux_sso=test' },
    }), env)
    assert.equal(response.status, 403)
    assert.equal(calls, before)
  })

  await t.test('登录回调代理使用固定上游并保留 HttpOnly Cookie', async () => {
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), 'https://auth.vertflux.com/edge/go/oauth2/callback?code=test&state=test')
      assert.equal(init.redirect, 'manual')
      return new Response('', { status: 302, headers: { Location: '/dashboard', 'Set-Cookie': '__Host-vertflux_sso=test; Path=/; Secure; HttpOnly; SameSite=Lax' } })
    }
    const app = createAuthGateway(options)
    const response = await app.fetch(new Request('https://go.vertflux.com/oauth2/callback?code=test&state=test', { headers: { Cookie: '__Host-vertflux_sso_fixture_csrf=test' } }), env)
    assert.equal(response.status, 302)
    assert.match(response.headers.get('Set-Cookie'), /Secure; HttpOnly/)
    const openRedirect = await app.fetch(new Request('https://go.vertflux.com/oauth2/start?rd=https://other.example'), env)
    assert.equal(openRedirect.status, 400)
  })

  await t.test('缺少 CSRF 的回调不发起换码，异常编码和扫描路径直接拒绝', async () => {
    globalThis.fetch = async () => { throw new Error('must not request auth') }
    const app = createAuthGateway(options)
    const before = calls
    for (const [path, status] of [['/oauth2/callback', 400], ['/oauth2/callback?code=test&state=test', 403], ['/%5capi/link/list', 400], ['/%255capi/link/list', 400], ['/.env', 404], ['/.git/config', 404]]) {
      assert.equal((await app.fetch(new Request(`https://go.vertflux.com${path}`), env)).status, status)
    }
    assert.equal(calls, before)
  })

  await t.test('两个 AI 入口的页面和模型 API 都受保护', async () => {
    for (const host of ['aidraw.vertflux.com', 'aiimage.vertflux.com']) {
      const app = createAuthGateway({ host })
      assert.equal((await app.fetch(new Request(`https://${host}/`), {})).status, 302)
      assert.equal((await app.fetch(new Request(`https://${host}/api/chat`), {})).status, 401)
    }
  })
})
