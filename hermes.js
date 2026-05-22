/**
 * Клиент Hermes Agent (OpenAI-совместимый API).
 * Документация: https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server
 */

const HERMES_API_URL = (process.env.HERMES_API_URL || 'http://127.0.0.1:8642').replace(/\/$/, '');
const HERMES_API_KEY = process.env.HERMES_API_KEY || '';
const HERMES_MODEL = process.env.HERMES_MODEL || 'hermes-agent';
const HERMES_TIMEOUT_MS = Number(process.env.HERMES_TIMEOUT_MS) || 120000;

function isHermesConfigured() {
  return Boolean(process.env.HERMES_API_URL) || process.env.HERMES_ENABLED === 'true';
}

async function hermesHealth() {
  const url = `${HERMES_API_URL}/health`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 8000);
  try {
    const headers = {};
    if (HERMES_API_KEY) headers.Authorization = `Bearer ${HERMES_API_KEY}`;
    const res = await fetch(url, { headers, signal: controller.signal });
    clearTimeout(t);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json().catch(() => ({}));
    return { ok: data.status === 'ok', url: HERMES_API_URL };
  } catch (e) {
    clearTimeout(t);
    return { ok: false, error: e.message || String(e), url: HERMES_API_URL };
  }
}

/**
 * @param {string} userPrompt
 * @param {{ chatName?: string, sender?: string }} context
 */
async function askHermes(userPrompt, context = {}) {
  const systemParts = [
    'Ты помощник в WhatsApp-боте пересылки сообщений. Отвечай кратко и по делу на русском, если пользователь пишет по-русски.',
  ];
  if (context.chatName) systemParts.push(`Чат: ${context.chatName}.`);
  if (context.sender) systemParts.push(`Отправитель: ${context.sender}.`);

  const body = {
    model: HERMES_MODEL,
    messages: [
      { role: 'system', content: systemParts.join(' ') },
      { role: 'user', content: String(userPrompt || '').trim() }
    ],
    stream: false
  };

  const headers = { 'Content-Type': 'application/json' };
  if (HERMES_API_KEY) headers.Authorization = `Bearer ${HERMES_API_KEY}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HERMES_TIMEOUT_MS);

  try {
    const res = await fetch(`${HERMES_API_URL}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });
    clearTimeout(timer);
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(text || `HTTP ${res.status}`);
    }
    if (!res.ok) {
      throw new Error(data.error?.message || data.error || text || `HTTP ${res.status}`);
    }
    const answer = data?.choices?.[0]?.message?.content;
    if (!answer) throw new Error('Пустой ответ от Hermes');
    return String(answer).trim();
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') {
      throw new Error('Таймаут ожидания Hermes (увеличьте HERMES_TIMEOUT_MS)');
    }
    throw e;
  }
}

const AI_PREFIXES = ['/ai', '/hermes', '/ии'];

function extractHermesPrompt(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  for (const p of AI_PREFIXES) {
    if (lower === p) return '';
    if (lower.startsWith(`${p} `)) return raw.slice(p.length).trim();
  }
  return null;
}

module.exports = {
  isHermesConfigured,
  hermesHealth,
  askHermes,
  extractHermesPrompt,
  HERMES_API_URL
};
