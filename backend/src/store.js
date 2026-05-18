import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, normalize } from 'node:path';

const LESSON_MIN = 1;
const LESSON_MAX = 45;
const NAME_MAX = 80;
const INDEX_MAX = 1000;

export function createStore(options = {}) {
  const dataDir = normalize(options.dataDir || join(process.cwd(), 'data'));
  const uploadDir = normalize(options.uploadDir || join(process.cwd(), 'uploads', 'avatars'));
  const dbPath = join(dataDir, 'kanji-academy.json');
  let readyPromise;
  let writeQueue = Promise.resolve();

  async function ready() {
    if (!readyPromise) {
      readyPromise = (async () => {
        await mkdir(dataDir, { recursive: true });
        await mkdir(uploadDir, { recursive: true });
        try {
          await readFile(dbPath, 'utf8');
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          await atomicWriteJson(dbPath, emptyDb());
        }
      })();
    }
    return readyPromise;
  }

  async function readDb() {
    await ready();
    const raw = await readFile(dbPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.users) return emptyDb();
    return parsed;
  }

  async function mutateDb(mutator) {
    writeQueue = writeQueue.then(async () => {
      const db = await readDb();
      const result = await mutator(db);
      db.updated_at = new Date().toISOString();
      await atomicWriteJson(dbPath, db);
      return result;
    });
    return writeQueue;
  }

  function sanitizeDeviceId(input) {
    if (typeof input === 'string' && /^[A-Za-z0-9_-]{16,96}$/.test(input)) {
      return input;
    }
    return randomUUID();
  }

  async function getOrCreateUser(deviceId) {
    const id = sanitizeDeviceId(deviceId);
    let created = false;
    const user = await mutateDb((db) => {
      if (!db.users[id]) {
        created = true;
        db.users[id] = createUser(id);
      }
      return structuredClone(db.users[id]);
    });
    return { user, deviceId: id, created };
  }

  async function getSnapshot(deviceId) {
    const { user, deviceId: id, created } = await getOrCreateUser(deviceId);
    return { deviceId: id, created, profile: user.profile, progress: user.progress };
  }

  async function updateProfile(deviceId, input) {
    const id = sanitizeDeviceId(deviceId);
    const cleanName = sanitizeName(input?.name);
    return mutateDb((db) => {
      if (!db.users[id]) db.users[id] = createUser(id);
      db.users[id].profile.name = cleanName;
      db.users[id].profile.updated_at = new Date().toISOString();
      return { deviceId: id, profile: structuredClone(db.users[id].profile) };
    });
  }

  async function updateProgress(deviceId, input) {
    const id = sanitizeDeviceId(deviceId);
    const progress = sanitizeProgress(input);
    return mutateDb((db) => {
      if (!db.users[id]) db.users[id] = createUser(id);
      db.users[id].progress = { ...progress, updated_at: new Date().toISOString() };
      return { deviceId: id, progress: structuredClone(db.users[id].progress) };
    });
  }

  async function saveAvatar(deviceId, input, limits = {}) {
    const id = sanitizeDeviceId(deviceId);
    const maxBytes = Number(limits.maxBytes || 1_000_000);
    const parsed = parseDataUrl(input?.dataUrl, maxBytes);
    const ext = parsed.mime === 'image/png' ? 'png' : 'jpg';
    const digest = createHash('sha256').update(parsed.buffer).digest('hex').slice(0, 16);
    const fileName = `${id}-${digest}.${ext}`;
    const filePath = join(uploadDir, fileName);
    await writeFile(filePath, parsed.buffer);
    return mutateDb((db) => {
      if (!db.users[id]) db.users[id] = createUser(id);
      db.users[id].profile.avatar_url = `/uploads/avatars/${fileName}`;
      db.users[id].profile.updated_at = new Date().toISOString();
      return { deviceId: id, profile: structuredClone(db.users[id].profile) };
    });
  }

  return {
    dataDir,
    uploadDir,
    ready,
    sanitizeDeviceId,
    getSnapshot,
    updateProfile,
    updateProgress,
    saveAvatar
  };
}

function emptyDb() {
  const now = new Date().toISOString();
  return { version: 1, created_at: now, updated_at: now, users: {} };
}

function createUser(id) {
  const now = new Date().toISOString();
  return {
    id,
    created_at: now,
    profile: { name: '', avatar_url: '', updated_at: now },
    progress: { lesson_number: 1, index_by_lesson: {}, updated_at: now }
  };
}

function sanitizeName(value) {
  if (typeof value !== 'string') return '';
  return [...value.trim()].slice(0, NAME_MAX).join('');
}

function sanitizeProgress(input) {
  const lesson = Number(input?.lesson_number);
  const lesson_number = Number.isInteger(lesson) && lesson >= LESSON_MIN && lesson <= LESSON_MAX ? lesson : 1;
  const cleanIndexes = {};
  const source = input?.index_by_lesson && typeof input.index_by_lesson === 'object' ? input.index_by_lesson : {};
  for (const [lessonKey, value] of Object.entries(source)) {
    const key = Number(lessonKey);
    const index = Number(value);
    if (!Number.isInteger(key) || key < LESSON_MIN || key > LESSON_MAX) continue;
    if (!Number.isInteger(index) || index < 0 || index > INDEX_MAX) continue;
    cleanIndexes[String(key)] = index;
  }
  return { lesson_number, index_by_lesson: cleanIndexes };
}

function parseDataUrl(dataUrl, maxBytes) {
  if (typeof dataUrl !== 'string') {
    throw Object.assign(new Error('Avatar dataUrl is required.'), { statusCode: 400 });
  }
  const match = /^data:(image\/png|image\/jpeg);base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl);
  if (!match) {
    throw Object.assign(new Error('Avatar must be a PNG or JPEG data URL.'), { statusCode: 415 });
  }
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > maxBytes) {
    throw Object.assign(new Error(`Avatar must be between 1 byte and ${maxBytes} bytes.`), { statusCode: 413 });
  }
  const mime = match[1].toLowerCase();
  if (mime === 'image/png' && !isPng(buffer)) {
    throw Object.assign(new Error('Invalid PNG avatar payload.'), { statusCode: 415 });
  }
  if (mime === 'image/jpeg' && !isJpeg(buffer)) {
    throw Object.assign(new Error('Invalid JPEG avatar payload.'), { statusCode: 415 });
  }
  return { mime, buffer };
}

function isPng(buffer) {
  return buffer.length > 8
    && buffer[0] === 0x89
    && buffer[1] === 0x50
    && buffer[2] === 0x4e
    && buffer[3] === 0x47
    && buffer[4] === 0x0d
    && buffer[5] === 0x0a
    && buffer[6] === 0x1a
    && buffer[7] === 0x0a;
}

function isJpeg(buffer) {
  return buffer.length > 4
    && buffer[0] === 0xff
    && buffer[1] === 0xd8
    && buffer[buffer.length - 2] === 0xff
    && buffer[buffer.length - 1] === 0xd9;
}

async function atomicWriteJson(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tmpPath, filePath);
}
