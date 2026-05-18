import { createServer } from 'node:http';
import { createKanjiApi } from './app.js';

const host = process.env.KANJI_HOST || '127.0.0.1';
const port = Number(process.env.KANJI_PORT || 8787);
const app = createKanjiApi();
const server = createServer(app);

server.listen(port, host, () => {
  console.log(`Kanji Academy backend listening on http://${host}:${port}`);
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down.`);
  server.close((error) => {
    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
    process.exit();
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
