import { CF_AI_MODEL, DEFAULT_GEMINI_MODEL } from './config.js';
import { errorText, truncate } from './utils.js';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/** Модель Gemini: можно переопределить переменной окружения GEMINI_MODEL. */
export function resolveGeminiModel(env) {
  return env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
}

/**
 * Извлечение текста из ответа Gemini.
 * Поддерживает оба формата: классический generateContent и новый Interactions API.
 */
function extractGeminiText(data) {
  const fromCandidates = (data?.candidates?.[0]?.content?.parts ?? [])
    .map((part) => part?.text)
    .filter(Boolean)
    .join('');
  if (fromCandidates.trim()) return fromCandidates.trim();

  const direct = data?.output_text ?? data?.outputText;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();

  const outputs = data?.outputs ?? data?.output;
  if (Array.isArray(outputs)) {
    const joined = outputs
      .map((item) => {
        if (typeof item === 'string') return item;
        if (typeof item?.text === 'string') return item.text;
        if (Array.isArray(item?.content)) {
          return item.content
            .map((c) => c?.text)
            .filter(Boolean)
            .join('');
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
    if (joined.trim()) return joined.trim();
  }

  return '';
}

/** Запрос к Gemini. Ключ передаём заголовком, а не в URL — так он не попадает в логи. */
async function geminiPost(env, path, payload) {
  const response = await fetch(`${GEMINI_BASE}/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': env.GEMINI_API_KEY,
    },
    body: JSON.stringify(payload),
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${truncate(raw, 200)}`);
  }

  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`некорректный JSON: ${truncate(raw, 120)}`);
  }

  const candidate = data?.candidates?.[0];
  return {
    text: extractGeminiText(data),
    finishReason: candidate?.finishReason ?? null,
    blockReason: data?.promptFeedback?.blockReason ?? null,
    partsCount: candidate?.content?.parts?.length ?? 0,
    usage: data?.usageMetadata ?? null,
  };
}

/**
 * Расшифровка пустого ответа Gemini.
 *
 * Без неё причина отката на резервного провайдера остаётся невидимой:
 * модель может ответить «успешно» (HTTP 200), но с пустым текстом,
 * если весь лимит вывода ушёл на внутренние «размышления».
 */
function describeEmptyResult(result) {
  const bits = [`finishReason=${result.finishReason ?? '—'}`, `частей=${result.partsCount}`];

  if (result.blockReason) bits.push(`blockReason=${result.blockReason}`);

  const usage = result.usage;
  if (usage) {
    bits.push(
      `вход=${usage.promptTokenCount ?? '—'}`,
      `размышления=${usage.thoughtsTokenCount ?? 0}`,
      `ответ=${usage.candidatesTokenCount ?? 0}`
    );
  }

  if (result.finishReason === 'MAX_TOKENS') {
    bits.push('→ лимит вывода исчерпан, увеличьте maxOutputTokens');
  }

  return bits.join(', ');
}

/**
 * Провайдер №1 — Google Gemini.
 * Пробуем два варианта API: сначала классический generateContent,
 * затем Interactions API (Google рекомендует его для новых моделей).
 * Возвращает { text, provider, errors }.
 */
async function askGemini(env, { system, prompt, maxTokens }) {
  if (!env.GEMINI_API_KEY) {
    return { text: null, provider: null, errors: ['секрет GEMINI_API_KEY не задан'] };
  }

  const model = resolveGeminiModel(env);
  const request = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
  };
  // Gemini 3.x тратит часть лимита на внутренние «размышления».
  // При тесном лимите ответ приходит пустым, и бот молча уходит на резерв.
  const outputLimit = Math.max(maxTokens * 4, 4096);

  const attempts = [
    {
      api: 'generateContent',
      path: `models/${model}:generateContent`,
      payload: { ...request, generationConfig: { maxOutputTokens: outputLimit, temperature: 0.3 } },
    },
    {
      // Страховка: тот же запрос, но с минимальными «размышлениями».
      // Если весь бюджет вывода был съеден ими, этот вариант успеет ответить.
      api: 'generateContent+low',
      path: `models/${model}:generateContent`,
      payload: {
        ...request,
        generationConfig: {
          maxOutputTokens: outputLimit,
          temperature: 0.3,
          thinkingConfig: { thinkingLevel: 'LOW' },
        },
      },
    },
    {
      api: 'interactions',
      path: 'interactions',
      payload: {
        model,
        input: system ? `${system}\n\n${prompt}` : prompt,
      },
    },
  ];

  const errors = [];
  for (const attempt of attempts) {
    const startedAt = Date.now();
    try {
      const result = await geminiPost(env, attempt.path, attempt.payload);
      const took = Date.now() - startedAt;

      if (result.text) {
        return { text: result.text, provider: `Gemini ${model} · ${attempt.api}`, errors };
      }

      const detail = describeEmptyResult(result);
      errors.push(`${attempt.api}: пустой ответ (${detail})`);
      console.error(`Gemini ${attempt.api}: пустой ответ за ${took} мс. ${detail}`);
    } catch (error) {
      const took = Date.now() - startedAt;
      const message = errorText(error);
      errors.push(`${attempt.api}: ${message}`);
      console.error(`Gemini ${attempt.api} не сработал за ${took} мс: ${message}`);
    }
  }

  return { text: null, provider: null, errors };
}

/** Провайдер №2 — Cloudflare Workers AI: резерв, не тратит внешние запросы. */
async function askCloudflare(env, { system, prompt, maxTokens }) {
  if (!env.AI) return { text: null, provider: null, errors: ['привязка AI недоступна'] };

  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });

  try {
    const response = await env.AI.run(CF_AI_MODEL, { messages, max_tokens: maxTokens });
    const text = (response?.response ?? '').trim();
    if (!text) return { text: null, provider: null, errors: ['Workers AI вернул пустой ответ'] };
    return { text, provider: `Workers AI · ${CF_AI_MODEL}`, errors: [] };
  } catch (error) {
    const message = errorText(error);
    console.error(`Workers AI не сработал: ${message}`);
    return { text: null, provider: null, errors: [message] };
  }
}

/**
 * Единая точка входа к ИИ: сначала Gemini, при неудаче — Workers AI.
 * Возвращает { text, provider } либо null, если недоступны оба провайдера.
 */
export async function askAI(env, options) {
  const gemini = await askGemini(env, options);
  if (gemini.text) return { text: gemini.text, provider: gemini.provider };

  const cloudflare = await askCloudflare(env, options);
  if (cloudflare.text) return { text: cloudflare.text, provider: cloudflare.provider };

  console.error(
    'Оба провайдера ИИ недоступны:',
    [...gemini.errors, ...cloudflare.errors].join(' | ')
  );
  return null;
}

/** Краткий обзор нового избранного проекта. */
export async function analyzeNewRepo(env, repo) {
  const prompt = `Объясни назначение GitHub-проекта "${repo.fullName}".
Описание: "${repo.description || 'отсутствует'}".
Напиши на русском языке ровно 2 предложения: что делает проект и кому он полезен.
Без вступлений, без Markdown, без списков.`;

  const result = await askAI(env, { prompt, maxTokens: 250 });
  if (result) return result;
  return { text: repo.description || 'Описание отсутствует', provider: null };
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

  const result = await askAI(env, {
    system: 'Ты лаконичный технический ассистент.',
    prompt,
    maxTokens: 500,
  });
  return result ?? { text: '', provider: null };
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

  const result = await askAI(env, {
    system: 'Ты профессиональный DevOps-инженер и системный архитектор.',
    prompt,
    maxTokens: 700,
  });
  return result ?? { text: 'Не удалось получить ответ от ИИ. Попробуйте позже.', provider: null };
}

/**
 * Проверка связи с Gemini — для команды /ai.
 *
 * В «реалистичном» режиме повторяет условия боевого запроса: системная инструкция,
 * длинный контекст и большой лимит вывода. Короткая проверка может проходить там,
 * где настоящий запрос стабильно падает, — поэтому нужны оба варианта.
 */
export async function testGemini(env, { realistic = false } = {}) {
  const model = resolveGeminiModel(env);
  const started = Date.now();

  const options = realistic
    ? {
        system: 'Ты профессиональный DevOps-инженер и системный архитектор.',
        prompt:
          'Пользователь задаёт технический вопрос по GitHub-репозиторию "example/project".\n\n' +
          'Контекст проекта (описание / README):\n' +
          'Это тестовый контекст, по объёму близкий к настоящему README проекта. '.repeat(40) +
          '\n\nВопрос пользователя: "Что делает этот проект?"\n\n' +
          'Ответь кратко, точечно и строго на русском языке.',
        maxTokens: 700,
      }
    : { prompt: 'Ответь ровно одним словом: работает', maxTokens: 64 };

  const result = await askGemini(env, options);

  return {
    model,
    realistic,
    ok: Boolean(result.text),
    provider: result.provider,
    ms: Date.now() - started,
    sample: result.text ?? '',
    errors: result.errors,
  };
}

/** Список моделей, доступных этому ключу — для команды /ai. */
export async function listGeminiModels(env) {
  if (!env.GEMINI_API_KEY) return [];

  const response = await fetch(`${GEMINI_BASE}/models?pageSize=200`, {
    headers: { 'x-goog-api-key': env.GEMINI_API_KEY },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${truncate(await response.text(), 200)}`);
  }

  const data = await response.json();
  const models = Array.isArray(data?.models) ? data.models : [];
  const names = models
    .map((model) => String(model?.name ?? '').replace(/^models\//, ''))
    .filter(Boolean);

  const usable = models
    .filter((model) => {
      const methods = model?.supportedGenerationMethods ?? model?.supportedActions ?? [];
      return methods.length === 0 || methods.includes('generateContent');
    })
    .map((model) => String(model?.name ?? '').replace(/^models\//, ''))
    .filter(Boolean);

  return usable.length > 0 ? usable : names;
}
