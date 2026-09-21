import { CF_AI_MODEL, GEMINI_MODEL } from './config.js';
import { truncate } from './utils.js';

const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

/** Запрос к Gemini. Ключ передаём заголовком, а не в URL — так он не попадает в логи. */
async function geminiPost(env, payload) {
  const response = await fetch(GEMINI_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': env.GEMINI_API_KEY,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Gemini HTTP ${response.status}: ${truncate(await response.text(), 200)}`);
  }

  const data = await response.json();
  const text = (data.candidates?.[0]?.content?.parts ?? [])
    .map((part) => part.text)
    .filter(Boolean)
    .join('');
  return text.trim() || null;
}

/** Провайдер №1 — Google Gemini: заметно лучше держит русский язык и технический контекст. */
async function askGemini(env, { system, prompt, maxTokens }) {
  if (!env.GEMINI_API_KEY) return null;

  const base = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
  };

  // Сначала пробуем отключить «размышления» — ответ быстрее и дешевле.
  // Если поле не поддерживается моделью, повторяем запрос в обычном режиме.
  const attempts = [
    {
      ...base,
      generationConfig: {
        maxOutputTokens: maxTokens,
        temperature: 0.3,
        thinkingConfig: { thinkingBudget: 0 },
      },
    },
    {
      ...base,
      generationConfig: { maxOutputTokens: Math.max(maxTokens, 1024), temperature: 0.3 },
    },
  ];

  for (const payload of attempts) {
    try {
      const text = await geminiPost(env, payload);
      if (text) return text;
    } catch (_error) {}
  }
  return null;
}

/** Провайдер №2 — Cloudflare Workers AI: резерв, не тратит внешние запросы. */
async function askCloudflare(env, { system, prompt, maxTokens }) {
  if (!env.AI) return null;

  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });

  const response = await env.AI.run(CF_AI_MODEL, { messages, max_tokens: maxTokens });
  const text = (response?.response ?? '').trim();
  return text || null;
}

/**
 * Единая точка входа к ИИ: сначала Gemini, при неудаче — Workers AI.
 * Возвращает null, если недоступны оба провайдера.
 */
export async function askAI(env, options) {
  try {
    const gemini = await askGemini(env, options);
    if (gemini) return gemini;
  } catch (_error) {}

  try {
    return await askCloudflare(env, options);
  } catch (_error) {
    return null;
  }
}

/** Краткий обзор нового избранного проекта. */
export async function analyzeNewRepo(env, repo) {
  const prompt = `Объясни назначение GitHub-проекта "${repo.fullName}".
Описание: "${repo.description || 'отсутствует'}".
Напиши на русском языке ровно 2 предложения: что делает проект и кому он полезен.
Без вступлений, без Markdown, без списков.`;

  const text = await askAI(env, { prompt, maxTokens: 250 });
  return text ?? (repo.description || 'Описание отсутствует');
}

/** Разбор нового релиза: что за проект и что изменилось. */
export async function analyzeRelease(env, repo, release, body) {
  const prompt = `Ты технический аналитик. Проанализируй проект "${repo.fullName}" и его новый релиз ${release.tag}.
Описание проекта: "${repo.description || 'отсутствует'}".

Release Notes:
${truncate(body || 'Release notes отсутствуют', 3000)}

Отвечай строго на русском языке в таком виде:
📌 О проекте: 1-2 предложения простыми словами.
🚀 Изменения: 2-4 главных нововведения, кратко и по делу.
Не используй Markdown-разметку.`;

  const text = await askAI(env, {
    system: 'Ты лаконичный технический ассистент.',
    prompt,
    maxTokens: 500,
  });
  return text ?? '';
}

/** Ответ на вопрос пользователя по конкретному репозиторию. */
export async function answerRepoQuestion(env, { fullName, description, readme, question }) {
  const context = readme ? truncate(readme, 4000) : description || 'Описание отсутствует';

  const prompt = `Пользователь задаёт технический вопрос по GitHub-репозиторию "${fullName}".

Контекст проекта (описание / README):
${context}

Вопрос пользователя: "${question}"

Ответь кратко, точечно и строго на русском языке. Приводи примеры конфигурации, если это уместно.
Не используй Markdown-разметку.`;

  const text = await askAI(env, {
    system: 'Ты профессиональный DevOps-инженер и системный архитектор.',
    prompt,
    maxTokens: 700,
  });
  return text ?? 'Не удалось получить ответ от ИИ. Попробуйте позже.';
}
