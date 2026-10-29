import http from 'node:http';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');
const indexFile = path.join(publicDir, 'index.html');
const port = Number(process.env.PORT || 8787);
const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2.1';
const voiceBySelection = {
  female: process.env.REALTIME_VOICE_FEMALE || 'shimmer',
  male: process.env.REALTIME_VOICE_MALE || 'echo',
};
const sessionCounts = new Map();
const MAX_SESSIONS_PER_IP = 3;
const MAX_CLIENT_MESSAGE = 256 * 1024;
const ALLOWED_CLIENT_EVENTS = new Set([
  'input_audio_buffer.append',
  'input_audio_buffer.commit',
  'input_audio_buffer.clear',
  'response.create',
  'response.cancel',
  'conversation.item.create',
]);

if (!apiKey) {
  console.error('OPENAI_API_KEY is required. Copy .env.example values into your environment.');
  process.exit(1);
}

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`).pathname;
  if (pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (pathname !== '/' && pathname !== '/index.html') {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  try {
    const file = await stat(indexFile);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': file.size,
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
    });
    createReadStream(indexFile).pipe(res);
  } catch {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('App file is missing. Put the updated HTML at public/index.html.');
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_MESSAGE, perMessageDeflate: false });

function rejectUpgrade(socket, status, message) {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

server.on('upgrade', (req, socket, head) => {
  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (requestUrl.pathname !== '/realtime-voice') return rejectUpgrade(socket, 404, 'Not Found');

  const origin = req.headers.origin;
  const configuredOrigin = process.env.APP_ORIGIN;
  if (!origin) return rejectUpgrade(socket, 403, 'Forbidden');
  if (configuredOrigin) {
    if (origin !== configuredOrigin) return rejectUpgrade(socket, 403, 'Forbidden');
  } else {
    try {
      if (new URL(origin).host !== req.headers.host) return rejectUpgrade(socket, 403, 'Forbidden');
    } catch {
      return rejectUpgrade(socket, 403, 'Forbidden');
    }
  }

  const selectedVoice = requestUrl.searchParams.get('selectedVoice');
  if (!Object.hasOwn(voiceBySelection, selectedVoice)) return rejectUpgrade(socket, 400, 'Bad Request');
  const ip = req.socket.remoteAddress || 'unknown';
  const currentSessions = sessionCounts.get(ip) || 0;
  if (currentSessions >= MAX_SESSIONS_PER_IP) return rejectUpgrade(socket, 429, 'Too Many Requests');

  wss.handleUpgrade(req, socket, head, (client) => {
    sessionCounts.set(ip, currentSessions + 1);
    wss.emit('connection', client, req, { selectedVoice, ip });
  });
});

wss.on('connection', (client, req, { selectedVoice, ip }) => {
  const voice = voiceBySelection[selectedVoice];
  const safeUserId = createHash('sha256').update(ip).digest('hex');
  const upstreamUrl = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
  const upstream = new WebSocket(upstreamUrl, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'OpenAI-Safety-Identifier': safeUserId,
    },
    perMessageDeflate: false,
  });
  let sessionReady = false;
  let closed = false;
  let audioBytesThisSecond = 0;
  let audioWindowStart = Date.now();
  const readyTimeout = setTimeout(() => {
    if (!sessionReady) {
      sendClient({ type: 'proxy.error', message: 'Realtime API session did not become ready in time.' });
      client.close(1011, 'Realtime session timeout');
      upstream.close();
    }
  }, 20000);

  function sendClient(event) {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(event));
  }
  function closeBoth(code = 1000, reason = 'closed') {
    if (closed) return;
    closed = true;
    clearTimeout(readyTimeout);
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close(code, reason);
    if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) client.close(code, reason);
  }

  upstream.on('open', () => {
    upstream.send(JSON.stringify({
      type: 'session.update',
      session: {
        type: 'realtime',
        model,
        output_modalities: ['audio'],
        instructions: [
          'تو دستیار صوتی محترم و دقیق فارسی برای اپلیکیشن همراه سازمان هستی. فارسی روان و کوتاه صحبت کن.',
          'صدای پاسخ را با voice تنظیم‌شدهٔ نشست تولید کن. کاربر در بخش ' + (selectedVoice === 'female' ? 'خواهران' : 'برادران') + ' است.',
          'برای هر درخواست بازکردن صفحه، دیدن بخش، رفتن به اطلاعیه یا نمایش پیام مشخص، ابزار navigate_to_page را فراخوانی کن. از کاربر نخواه برای تغییر صفحه کلیک کند.',
          'برای پیام مشخص، page را message و message_title را عنوان یا عبارت متمایز پیام قرار بده. فقط صفحه‌هایی را درخواست کن که در فهرست ابزار هستند.',
          'پس از اجرای ابزار، پاسخ صوتی کوتاه و مؤدبانه بده. اگر درخواست مبهم است یک سؤال روشن‌کننده بپرس و ابزار را اجرا نکن.',
        ].join(' '),
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            turn_detection: null,
          },
          output: {
            format: { type: 'audio/pcm', rate: 24000 },
            voice,
          },
        },
        tools: [{
          type: 'function',
          name: 'navigate_to_page',
          description: 'بازکردن صفحه یا پیام در رابط اپ. هرگز این ابزار را برای تغییر داده‌ها یا انجام عملیات مدیریتی استفاده نکن.',
          parameters: {
            type: 'object',
            properties: {
              page: {
                type: 'string',
                enum: ['admin', 'news', 'gallery', 'settings', 'add', 'reports', 'traffic', 'points', 'members', 'message'],
                description: 'شناسهٔ بخش اپ؛ برای نمایش پیام مشخص از message استفاده کن.',
              },
              message_title: {
                type: 'string',
                description: 'عنوان یا عبارت متمایز پیام، فقط وقتی page برابر message است.',
              },
            },
            required: ['page'],
            additionalProperties: false,
          },
        }],
        tool_choice: 'auto',
      },
    }));
  });

  upstream.on('message', (data) => {
    let event;
    try {
      event = JSON.parse(data.toString());
    } catch {
      sendClient({ type: 'proxy.error', message: 'Invalid event from Realtime API.' });
      return;
    }
    if (event.type === 'session.updated' && !sessionReady) {
      sessionReady = true;
      clearTimeout(readyTimeout);
      sendClient({ type: 'proxy.ready', selectedVoice, voice, model });
    }
    // Audio deltas and tool-call events are passed through immediately.
    sendClient(event);
  });

  upstream.on('error', (error) => {
    sendClient({ type: 'proxy.error', message: 'Realtime upstream connection failed.' });
    console.error('Realtime upstream error:', error.message);
  });
  upstream.on('close', (code, reason) => {
    if (client.readyState === WebSocket.OPEN) client.close(1011, reason?.toString() || 'upstream closed');
  });

  client.on('message', (raw) => {
    if (upstream.readyState !== WebSocket.OPEN || !sessionReady) {
      sendClient({ type: 'proxy.error', message: 'Realtime session is not ready.' });
      return;
    }
    let event;
    try {
      event = JSON.parse(raw.toString());
    } catch {
      sendClient({ type: 'proxy.error', message: 'Malformed client event.' });
      return;
    }
    if (!ALLOWED_CLIENT_EVENTS.has(event.type)) {
      sendClient({ type: 'proxy.error', message: 'Client event is not allowed.' });
      return;
    }
    if (event.type === 'input_audio_buffer.append') {
      if (typeof event.audio !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(event.audio)) {
        sendClient({ type: 'proxy.error', message: 'Audio chunk must be base64 PCM.' });
        return;
      }
      const bytes = Math.floor(event.audio.length * 3 / 4);
      const now = Date.now();
      if (now - audioWindowStart >= 1000) {
        audioWindowStart = now;
        audioBytesThisSecond = 0;
      }
      audioBytesThisSecond += bytes;
      if (bytes > 96 * 1024 || audioBytesThisSecond > 512 * 1024) {
        sendClient({ type: 'proxy.error', message: 'Audio input rate exceeded the session limit.' });
        closeBoth(1009, 'audio rate limit');
        return;
      }
      upstream.send(JSON.stringify({ type: event.type, audio: event.audio }));
      return;
    }
    if (event.type === 'conversation.item.create') {
      const item = event.item;
      if (!item || item.type !== 'function_call_output' || typeof item.call_id !== 'string' || typeof item.output !== 'string' || item.output.length > 4000) {
        sendClient({ type: 'proxy.error', message: 'Only bounded function_call_output items are accepted.' });
        return;
      }
      upstream.send(JSON.stringify({ type: event.type, item: { type: 'function_call_output', call_id: item.call_id, output: item.output } }));
      return;
    }
    if (event.type === 'response.create') {
      upstream.send(JSON.stringify({ type: 'response.create', response: { output_modalities: ['audio'] } }));
      return;
    }
    upstream.send(JSON.stringify({ type: event.type }));
  });

  client.on('close', () => {
    clearTimeout(readyTimeout);
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close(1000, 'browser closed');
    const remaining = Math.max(0, (sessionCounts.get(ip) || 1) - 1);
    if (remaining) sessionCounts.set(ip, remaining); else sessionCounts.delete(ip);
  });
  client.on('error', (error) => console.error('Browser websocket error:', error.message));
});

server.listen(port, () => console.log(`Persian Realtime app listening on http://localhost:${port}`));
