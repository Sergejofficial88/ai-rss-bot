import { handleTelegramCallback, handleTelegramMessage } from './commands.js';
import { sendTelegramMessage } from './telegram.js';
import { runCheck } from './tracker.js';
import { errorText, escapeHtml } from './utils.js';

/**
 * Ошибка внутри обработчика не должна превращаться в молчание.
 * Пользователь получает текст ошибки, а в логах остаётся диагностика.
 */
async function reportFailure(env, chatId, error) {
  console.error('Ошибка обработки обновления:', error);

  try {
    await sendTelegramMessage(
      env,
      chatId ?? env.ALLOWED_TELEGRAM_ID,
      `<b>⚠️ Ошибка обработки запроса:</b>\n<code>${escapeHtml(errorText(error))}</code>`
    );
  } catch (sendError) {
    console.error('Не удалось сообщить об ошибке:', errorText(sendError));
  }
}

export default {
  /** Автоматическая проверка по расписанию (Cron Trigger). */
  async scheduled(_event, env) {
    try {
      await runCheck(env);
    } catch (error) {
      await sendTelegramMessage(
        env,
        env.ALLOWED_TELEGRAM_ID,
        `<b>⚠️ Ошибка авто-проверки (Cron):</b>\n<code>${escapeHtml(errorText(error))}</code>`
      );
    }
  },

  /** Вебхук Telegram и ручной запуск проверки. */
  async fetch(request, env) {
    const url = new URL(request.url);

    // Ручной запуск проверки: /run?token=...
    if (url.pathname === '/run') {
      if (env.RUN_TOKEN && url.searchParams.get('token') !== env.RUN_TOKEN) {
        return new Response('403 Forbidden', { status: 403 });
      }

      try {
        const report = await runCheck(env);
        return new Response(`Проверка завершена успешно.\n\n${report}`, { status: 200 });
      } catch (error) {
        return new Response(`Ошибка: ${errorText(error)}`, { status: 500 });
      }
    }

    if (request.method !== 'POST') {
      return new Response('GitHub Release AI Bot is running.', { status: 200 });
    }

    // Проверка секрета вебхука: отсекает поддельные обновления от посторонних.
    if (env.TELEGRAM_WEBHOOK_SECRET) {
      const received = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
      if (received !== env.TELEGRAM_WEBHOOK_SECRET) {
        // Без этого лога «бот молчит» выглядит необъяснимо: все обновления
        // отклоняются ещё до обработки, и в чат не приходит даже «⏳».
        console.error(
          'Вебхук отклонён: неверный X-Telegram-Bot-Api-Secret-Token. ' +
            'Проверьте, что secret_token при setWebhook совпадает с TELEGRAM_WEBHOOK_SECRET.'
        );
        return new Response('403 Forbidden', { status: 403 });
      }
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response('OK', { status: 200 });
    }

    // ВАЖНО: здесь был ctx.waitUntil(). На Free-плане такие задачи отменяются,
    // если не успели завершиться после ответа (в логах: «waitUntil() tasks ...
    // have been cancelled»). Именно поэтому бот молчал, хотя обновления доходили.
    // Ждём обработчик прямо в запросе: у HTTP-вызова нет жёсткого лимита
    // длительности, а Telegram спокойно пережидает ответ несколько секунд.
    if (update.message) {
      await handleTelegramMessage(env, update.message).catch((error) =>
        reportFailure(env, update.message?.chat?.id, error)
      );
    } else if (update.callback_query) {
      await handleTelegramCallback(env, update.callback_query).catch((error) =>
        reportFailure(env, update.callback_query?.message?.chat?.id, error)
      );
    }

    return new Response('OK', { status: 200 });
  },
};
