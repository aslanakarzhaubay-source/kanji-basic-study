import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { createStore } from './store.js';

const DEFAULT_MAX_JSON_BYTES = 1_500_000;
const DEFAULT_MAX_AVATAR_BYTES = 1_000_000;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT_MAX = 180;

export function createKanjiApi(options = {}) {
  const store = options.store || createStore({
    dataDir: options.dataDir || process.env.KANJI_DATA_DIR,
    uploadDir: options.uploadDir || join(process.cwd(), 'uploads', 'avatars')
  });
  const allowedOrigins = parseOrigins(options.allowedOrigins ?? process.env.KANJI_ALLOWED_ORIGINS);
  const maxJsonBytes = Number(options.maxJsonBytes || process.env.KANJI_MAX_JSON_BYTES || DEFAULT_MAX_JSON_BYTES);
  const maxAvatarBytes = Number(options.maxAvatarBytes || process.env.KANJI_MAX_AVATAR_BYTES || DEFAULT_MAX_AVATAR_BYTES);
  const rateLimiter = createRateLimiter({
    windowMs: Number(options.rateLimitWindowMs || process.env.KANJI_RATE_LIMIT_WINDOW_MS || DEFAULT_RATE_LIMIT_WINDOW_MS),
    max: Number(options.rateLimitMax || process.env.KANJI_RATE_LIMIT_MAX || DEFAULT_RATE_LIMIT_MAX)
  });

  return async function app(req, res) {
    try {
      applySecurityHeaders(res);
      applyCors(req, res, allowedOrigins);

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (!rateLimiter(req)) {
        sendJson(req, res, 429, { error: 'rate_limited', message: 'Too many requests.' });
        return;
      }

      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const route = `${req.method} ${url.pathname}`;

      if (route === 'GET /health') {
        sendJson(req, res, 200, { status: 'ok', service: 'kanji-academy-backend', version: '1.0.0' });
        return;
      }

      if (route === 'GET /api/v1/snapshot') {
        const snapshot = await store.getSnapshot(getDeviceId(req));
        setDeviceId(res, snapshot.deviceId);
        sendJson(req, res, 200, snapshot);
        return;
      }

      if (route === 'PATCH /api/v1/profile') {
        const body = await readJson(req, maxJsonBytes);
        const result = await store.updateProfile(getDeviceId(req), body);
        setDeviceId(res, result.deviceId);
        sendJson(req, res, 200, result);
        return;
      }

      if (route === 'PUT /api/v1/progress') {
        const body = await readJson(req, maxJsonBytes);
        const result = await store.updateProgress(getDeviceId(req), body);
        setDeviceId(res, result.deviceId);
        sendJson(req, res, 200, result);
        return;
      }

      if (route === 'POST /api/v1/profile/avatar') {
        const body = await readJson(req, maxJsonBytes);
        const result = await store.saveAvatar(getDeviceId(req), body, { maxBytes: maxAvatarBytes });
        setDeviceId(res, result.deviceId);
        sendJson(req, res, 200, result);
        return;
      }

      if (req.method === 'GET' && url.pathname.startsWith('/uploads/avatars/')) {
        await serveAvatar(req, res, store.uploadDir, url.pathname);
        return;
      }

      sendJson(req, res, 404, { error: 'not_found', message: 'Route not found.' });
    } catch (error) {
      const statusCode = Number(error.statusCode || 500);
      sendJson(req, res, statusCode, {
        error: statusCode >= 500 ? 'internal_error' : 'bad_request',
        message: statusCode >= 500 ? 'Internal server error.' : error.message
      });
    }
  };
}

function getDeviceId(req) {
  const value = req.headers['x-kanji-device-id'];
  return Array.isArray(value) ? value[0] : value;
}

function setDeviceId(res, deviceId) {
  res.setHeader('X-Kanji-Device-Id', deviceId);
}

function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
}

function applyCors(req, res, allowedOrigins) {
  const origin = req.headers.origin;
  const allowOrigin = !origin || allowedOrigins.size === 0 || allowedOrigins.has(origin);
  if (origin && allowOrigin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Kanji-Device-Id');
  res.setHeader('Access-Control-Expose-Headers', 'X-Kanji-Device-Id');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function parseOrigins(value) {
  if (Array.isArray(value)) return new Set(value.filter(Boolean));
  if (typeof value !== 'string' || !value.trim()) return new Set();
  return new Set(value.split(',').map((item) => item.trim()).filter(Boolean));
}

function createRateLimiter(options) {
  const buckets = new Map();
  return (req) => {
    const now = Date.now();
    const ip = req.socket.remoteAddress || 'unknown';
    const current = buckets.get(ip);
    if (!current || now - current.startedAt > options.windowMs) {
      buckets.set(ip, { startedAt: now, count: 1 });
      return true;
    }
    current.count += 1;
    return current.count <= options.max;
  };
}

async function readJson(req, maxBytes) {
  const contentType = req.headers['content-type'] || '';
  if (!String(contentType).toLowerCase().includes('application/json')) {
    throw Object.assign(new Error('Content-Type must be application/json.'), { statusCode: 415 });
  }
  let total = 0;
  const chunks = [];
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw Object.assign(new Error(`JSON body exceeds ${maxBytes} bytes.`), { statusCode: 413 });
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Malformed JSON body.'), { statusCode: 400 });
  }
}

function sendJson(req, res, statusCode, body) {
  if (res.headersSent) return;
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(payload.length),
    'Cache-Control': req.method === 'GET' && statusCode === 200 ? 'no-store' : 'no-store'
  });
  res.end(payload);
}

async function serveAvatar(req, res, uploadDir, pathname) {
  const fileName = decodeURIComponent(pathname.split('/').pop() || '');
  if (!/^[A-Za-z0-9_-]+-[a-f0-9]{16}\.(jpg|png)$/i.test(fileName)) {
    sendJson(req, res, 404, { error: 'not_found', message: 'Avatar not found.' });
    return;
  }
  const filePath = normalize(join(uploadDir, fileName));
  const uploadRoot = normalize(uploadDir);
  if (!filePath.startsWith(uploadRoot)) {
    sendJson(req, res, 404, { error: 'not_found', message: 'Avatar not found.' });
    return;
  }
  try {
    const fileStat = await stat(filePath);
    const type = extname(filePath).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': String(fileStat.size),
      'Cache-Control': 'public, max-age=31536000, immutable'
    });
    createReadStream(filePath).pipe(res);
  } catch {
    sendJson(req, res, 404, { error: 'not_found', message: 'Avatar not found.' });
  }
}
