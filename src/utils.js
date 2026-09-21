/** Общие вспомогательные функции. */

/** Экранирование HTML для `parse_mode: "HTML"` в Telegram. */
export function escapeHtml(text) {
  if (text === undefined || text === null) return '';
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Обрезка строки до указанной длины с многоточием. */
export function truncate(text, max) {
  const value = String(text ?? '');
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Проверка формата `owner/repo`.
 * Защищает от подстановки произвольных путей в URL GitHub API.
 */
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function isValidRepoName(name) {
  return typeof name === 'string' && REPO_PATTERN.test(name);
}

/** Текущее время в ISO-формате. */
export function nowIso() {
  return new Date().toISOString();
}

/** Текст ошибки для логов (в catch переменная имеет тип unknown). */
export function errorText(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Форматирование даты для сообщений (в UTC, чтобы не зависеть от региона). */
export function formatDateTime(iso) {
  const date = iso ? new Date(iso) : new Date();
  if (Number.isNaN(date.getTime())) return '';
  const formatted = date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  });
  return `${formatted} UTC`;
}

/**
 * Разбиение длинного текста на части по лимиту Telegram.
 * Старается не разрывать сообщение посреди строки.
 */
export function chunkText(text, limit) {
  const value = String(text ?? '');
  if (value.length <= limit) return [value];

  const chunks = [];
  let rest = value;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/**
 * Последовательный обход массива с ограничением параллелизма.
 * Нужен, чтобы не превысить лимит одновременных соединений Workers (6).
 */
export async function mapLimit(items, limit, mapper) {
  const results = [];
  for (let index = 0; index < items.length; index += limit) {
    const slice = items.slice(index, index + limit);
    const mapped = await Promise.all(slice.map(mapper));
    results.push(...mapped);
  }
  return results;
}
