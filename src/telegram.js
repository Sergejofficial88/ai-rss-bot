import { MAX_MESSAGE_LENGTH } from './config.js';
import { chunkText } from './utils.js';

function apiUrl(env, method) {
  return `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
}

/**
 * Универсальный вызов Telegram Bot API.
 * Всегда проверяет ответ: иначе ошибки отправки остаются незамеченными.
 */
export async function tgCall(env, method, payload) {
  const response = await fetch(apiUrl(env, method), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!data?.ok) {
  }
  return data;
}

/** Отправка сообщения с автоматической разбивкой слишком длинного текста. */
export async function sendTelegramMessage(env, chatId, text, replyMarkup = null) {
  const chunks = chunkText(text, MAX_MESSAGE_LENGTH);
  let last = null;

  for (let index = 0; index < chunks.length; index++) {
    const isLast = index === chunks.length - 1;
    last = await tgCall(env, 'sendMessage', {
      chat_id: chatId,
      text: chunks[index],
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(isLast && replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }

  return last;
}

/** Редактирование сообщения — используется для пагинации списка репозиториев. */
export async function editTelegramMessage(env, chatId, messageId, text, replyMarkup = null) {
  return tgCall(env, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

/** Ответ на нажатие inline-кнопки (убирает «часики» у клиента). */
export async function answerCallbackQuery(env, callbackQueryId, text) {
  return tgCall(env, 'answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    ...(text ? { text } : {}),
  });
}

/** Постоянное меню бота. */
export function mainMenuKeyboard() {
  return {
    keyboard: [[{ text: '🔄 Проверить релизы' }, { text: '📋 Список Starred-репо' }]],
    resize_keyboard: true,
    persistent: true,
  };
}

/** Telegram ограничивает callback_data 64 байтами — длинные имена не помещаем в кнопку. */
export const CALLBACK_DATA_LIMIT = 64;

/** Кнопка «Спросить ИИ» или null, если имя репозитория слишком длинное. */
export function buildAskButton(fullName) {
  const data = `ask_init:${fullName}`;
  if (data.length > CALLBACK_DATA_LIMIT) return null;
  return { text: '💬 Спросить ИИ', callback_data: data };
}
