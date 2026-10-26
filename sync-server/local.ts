// Локальный посредник для проверки на двух «телефонах» в браузере:
//   npx vite-node sync-server/local.ts      (порт 8690, хранилище в памяти)
// Пускает запросы только с localhost и 127.0.0.1.

import { createServer } from 'node:http';
import { handleSync, memoryStore } from './core';

const PORT = Number(process.env.PORT ?? 8690);
const store = memoryStore();

createServer(async (req, res) => {
  const origin = req.headers.origin ?? '';
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' }).end();
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`rashody sync (local), объектов: ${store.size()}\n`);
    return;
  }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' }).end('{"error":"bad json"}');
    return;
  }
  const result = await handleSync(store, input);
  console.log(new Date().toISOString().slice(11, 19), (input as { op?: string }).op, result.status, `объектов: ${store.size()}`);
  res.writeHead(result.status, { 'Content-Type': 'application/json' }).end(JSON.stringify(result.body));
}).listen(PORT, '127.0.0.1', () => console.log(`rashody sync (local) на http://127.0.0.1:${PORT}`));
