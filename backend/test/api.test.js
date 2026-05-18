import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createKanjiApi } from '../src/app.js';
import { createStore } from '../src/store.js';

const PNG_1X1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

test('profile, progress, and avatar API roundtrip', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kanji-api-'));
  const uploadDir = join(root, 'uploads', 'avatars');
  const store = createStore({ dataDir: join(root, 'data'), uploadDir });
  const app = createKanjiApi({
    store,
    allowedOrigins: ['http://127.0.0.1:8793'],
    rateLimitMax: 1000
  });
  const server = createServer(app);

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const health = await request(baseUrl, '/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.status, 'ok');

    const first = await request(baseUrl, '/api/v1/snapshot');
    assert.equal(first.status, 200);
    assert.match(first.body.deviceId, /^[A-Za-z0-9_-]{16,96}$/);
    assert.equal(first.body.progress.lesson_number, 1);
    const deviceId = first.body.deviceId;

    const profile = await request(baseUrl, '/api/v1/profile', {
      method: 'PATCH',
      deviceId,
      body: { name: '山田 太郎 محمد' }
    });
    assert.equal(profile.status, 200);
    assert.equal(profile.body.profile.name, '山田 太郎 محمد');

    const progress = await request(baseUrl, '/api/v1/progress', {
      method: 'PUT',
      deviceId,
      body: { lesson_number: 17, index_by_lesson: { 17: 2, bad: 'no' } }
    });
    assert.equal(progress.status, 200);
    assert.equal(progress.body.progress.lesson_number, 17);
    assert.deepEqual(progress.body.progress.index_by_lesson, { 17: 2 });

    const avatar = await request(baseUrl, '/api/v1/profile/avatar', {
      method: 'POST',
      deviceId,
      body: { dataUrl: PNG_1X1 }
    });
    assert.equal(avatar.status, 200);
    assert.match(avatar.body.profile.avatar_url, /^\/uploads\/avatars\/.+\.png$/);

    const avatarFile = await fetch(`${baseUrl}${avatar.body.profile.avatar_url}`);
    assert.equal(avatarFile.status, 200);
    assert.equal(avatarFile.headers.get('content-type'), 'image/png');

    const snapshot = await request(baseUrl, '/api/v1/snapshot', { deviceId });
    assert.equal(snapshot.body.profile.name, '山田 太郎 محمد');
    assert.equal(snapshot.body.progress.lesson_number, 17);
    assert.equal(snapshot.body.progress.index_by_lesson['17'], 2);
    assert.equal(snapshot.body.profile.avatar_url, avatar.body.profile.avatar_url);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects invalid avatar payloads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kanji-api-'));
  const store = createStore({ dataDir: join(root, 'data'), uploadDir: join(root, 'uploads', 'avatars') });
  const server = createServer(createKanjiApi({ store, rateLimitMax: 1000 }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const response = await request(baseUrl, '/api/v1/profile/avatar', {
      method: 'POST',
      body: { dataUrl: 'data:image/gif;base64,AAAA' }
    });
    assert.equal(response.status, 415);
    assert.equal(response.body.error, 'bad_request');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

async function request(baseUrl, path, options = {}) {
  const headers = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.deviceId) headers['X-Kanji-Device-Id'] = options.deviceId;
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const body = await response.json();
  return { status: response.status, headers: response.headers, body };
}
