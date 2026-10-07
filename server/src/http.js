'use strict';
// 小さなWebサーバーの部品(ルーター・Cookie・静的ファイル・セキュリティヘッダ)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { config } = require('./config');

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:",
  "connect-src 'self'", "font-src 'self'", "object-src 'none'", "frame-ancestors 'none'",
  "base-uri 'none'", "form-action 'self'",
].join('; ');

function baseHeaders(extra = {}) {
  return {
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    ...extra,
  };
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const raw = part.slice(i + 1).trim();
    let val = raw;
    try { val = decodeURIComponent(raw); } catch { /* 壊れた値はそのまま扱う(認証には使えない値になる) */ }
    out[part.slice(0, i).trim()] = val;
  }
  return out;
}

function cookieString(name, value, { maxAgeSec, path: p = '/', sameSite = 'Lax' } = {}) {
  let s = `${name}=${encodeURIComponent(value)}; Path=${p}; HttpOnly; SameSite=${sameSite}`;
  if (maxAgeSec !== undefined) s += `; Max-Age=${maxAgeSec}`;
  if (config.COOKIE_SECURE) s += '; Secure';
  return s;
}

class App {
  constructor() { this.routes = []; this.authHook = null; }
  add(method, pattern, opts, handler) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:[a-zA-Z]+/g, m => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$');
    this.routes.push({ method, re, keys, opts, handler });
  }
  get(p, o, h) { this.add('GET', p, o, h); }
  post(p, o, h) { this.add('POST', p, o, h); }
  put(p, o, h) { this.add('PUT', p, o, h); }
  del(p, o, h) { this.add('DELETE', p, o, h); }

  async readBody(req, limit) {
    const chunks = []; let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > limit) throw new HttpError(413, 'データが大きすぎます。');
      chunks.push(c);
    }
    if (!size) return {};
    const ct = String(req.headers['content-type'] || '');
    if (!ct.startsWith('application/json')) throw new HttpError(415, '形式が正しくありません。');
    let parsed;
    try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new HttpError(400, 'データの形式が正しくありません。'); }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, 'データの形式が正しくありません。');
    return parsed;
  }

  async handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const ctx = {
      req, res, url, query: Object.fromEntries(url.searchParams), params: {}, body: {},
      cookies: parseCookies(req.headers.cookie), ip: req.socket.remoteAddress || '',
      setCookies: [],
    };
    try {
      if (url.pathname.startsWith('/api/')) {
        const route = this.match(req.method, url.pathname, ctx);
        if (!route) throw new HttpError(404, '見つかりません。');
        if (req.method !== 'GET') this.csrfCheck(req);
        if (req.method !== 'GET' && req.method !== 'DELETE') ctx.body = await this.readBody(req, route.opts.bodyLimit || 1024 * 1024);
        if (this.authHook) this.authHook(ctx, route.opts);
        const out = await route.handler(ctx);
        if (ctx.handled) return;
        this.sendJson(res, 200, out === undefined ? { ok: true } : out, ctx);
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, '許可されていません。');
      this.serveStatic(url.pathname, res, req.method === 'HEAD', ctx);
    } catch (e) {
      if (e instanceof HttpError) {
        if (url.pathname.startsWith('/api/')) this.sendJson(res, e.status, { error: e.message, ...(e.extra || {}) }, ctx);
        else this.sendText(res, e.status, e.message);
      } else {
        console.error(new Date().toISOString(), 'ERROR', req.method, url.pathname, e);
        if (url.pathname.startsWith('/api/')) this.sendJson(res, 500, { error: 'サーバーでエラーが発生しました。' }, ctx);
        else this.sendText(res, 500, 'サーバーでエラーが発生しました。');
      }
    }
  }

  match(method, pathname, ctx) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(pathname);
      if (!m) continue;
      try { r.keys.forEach((k, i) => { ctx.params[k] = decodeURIComponent(m[i + 1]); }); } catch { return null; }
      return r;
    }
    return null;
  }

  // CSRF対策: 変更系APIは「独自ヘッダ付き」かつ「同一オリジン」のリクエストだけ受け付ける
  csrfCheck(req) {
    if (req.headers['x-requested-with'] !== 'kintai') throw new HttpError(403, '不正なリクエストです。');
    const origin = req.headers.origin;
    if (origin) {
      let host = '';
      try { host = new URL(origin).host; } catch { /* fallthrough */ }
      if (host !== req.headers.host) throw new HttpError(403, '不正なリクエストです。');
    }
  }

  sendJson(res, status, obj, ctx) {
    const body = JSON.stringify(obj);
    const headers = baseHeaders({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    if (ctx && ctx.setCookies.length) headers['Set-Cookie'] = ctx.setCookies;
    res.writeHead(status, headers);
    res.end(body);
  }
  sendText(res, status, text) {
    res.writeHead(status, baseHeaders({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }));
    res.end(text);
  }
  sendBuffer(res, ctx, buf, contentType, filename) {
    const headers = baseHeaders({
      'Content-Type': contentType, 'Cache-Control': 'no-store', 'Content-Length': buf.length,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    });
    res.writeHead(200, headers);
    res.end(buf);
    ctx.handled = true;
  }

  serveStatic(pathname, res, headOnly, ctx) {
    let rel;
    try { rel = decodeURIComponent(pathname); } catch { throw new HttpError(400, 'アドレスが正しくありません。'); }
    if (rel.includes('\0')) throw new HttpError(400, 'アドレスが正しくありません。');
    const pages = { '/': 'index.html', '/tablet': 'tablet.html', '/p': 'punch.html', '/admin': 'admin.html', '/me': 'punch.html' };
    if (pages[rel]) rel = '/' + pages[rel];
    const file = path.normalize(path.join(config.PUBLIC_DIR, rel));
    if (!file.startsWith(config.PUBLIC_DIR + path.sep)) throw new HttpError(404, '見つかりません。');
    let st;
    try { st = fs.statSync(file); } catch { throw new HttpError(404, '見つかりません。'); }
    if (!st.isFile()) throw new HttpError(404, '見つかりません。');
    const type = MIME[path.extname(file)] || 'application/octet-stream';
    const headers = baseHeaders({ 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
    res.writeHead(200, headers);
    if (headOnly) return res.end();
    fs.createReadStream(file).pipe(res);
  }
}

function createServer(app) {
  const server = http.createServer((req, res) => {
    app.handle(req, res).catch(e => {
      console.error('handle error', e);
      if (!res.headersSent) { res.writeHead(500, baseHeaders({ 'Content-Type': 'text/plain; charset=utf-8' })); }
      res.end('サーバーでエラーが発生しました。');
    });
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  return server;
}

module.exports = { App, HttpError, createServer, parseCookies, cookieString };
