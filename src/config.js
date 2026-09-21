/**
 * Константы проекта.
 * Секреты и настройки окружения читаются из `env` (Cloudflare secrets / vars).
 */

export const GITHUB_GRAPHQL_URL = 'https://api.github.com/graphql';
export const GITHUB_API_URL = 'https://api.github.com';

/**
 * Сколько репозиториев показывать на одной странице.
 * Небольшое значение выбрано намеренно: у каждого репозитория своя кнопка,
 * и чем меньше кнопок в сообщении, тем понятнее, какая к какому проекту относится.
 */
export const REPOS_PER_PAGE = 6;

/** Время жизни контекста вопроса, карточки репозитория и кэша списка, в секундах. */
export const ASK_TTL_SECONDS = 300;
export const CARD_TTL_SECONDS = 900;
export const REPOS_CACHE_TTL_SECONDS = 300;

/** Лимит длины сообщения Telegram — 4096 символов, берём с запасом. */
export const MAX_MESSAGE_LENGTH = 4000;

/** Telegram ограничивает callback_data 64 байтами. */
export const CALLBACK_DATA_LIMIT = 64;

/**
 * Ограничители рассылки за один прогон.
 * Workers Free разрешает всего 50 внешних запросов на вызов, поэтому
 * количество уведомлений и обращений к ИИ обязано быть ограничено.
 */
export const MAX_REPO_NOTICES_PER_RUN = 5;
export const MAX_RELEASE_NOTICES_PER_RUN = 5;
export const MAX_AI_CALLS_PER_RUN = 8;

/**
 * ИИ-модели.
 * Gemini — основная модель; её можно переопределить секретом `GEMINI_MODEL`
 * (например: gemini-3.8-flash, gemini-3.7-flash, gemini-3.5-flash-lite).
 * Workers AI — резервный провайдер, работает без внешних запросов.
 */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
export const CF_AI_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

/** Ключи состояния в KV. */
export const KV_KEYS = {
  initialized: 'meta:initialized',
  lastRun: 'meta:last_run',
  reposCache: 'cache:repos',
  starred: (fullName) => `starred:${fullName}`,
  release: (fullName) => `release:${fullName}`,
  ask: (chatId, userId) => `ask:${chatId}:${userId}`,
  card: (chatId, messageId) => `card:${chatId}:${messageId}`,
};
