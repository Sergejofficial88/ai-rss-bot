import { handleTelegramCallback, handleTelegramMessage } from './commands.js';
import { sendTelegramMessage } from './telegram.js';
import { runCheck } from './tracker.js';
import { errorText, escapeHtml } from './utils.js';

export default {
  /** Автоматическая проверка по расписанию (Cron Trigger). */
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      runCheck(env).catch(async (error) => {
        await sendTelegramMessage(
          env,
          env.ALLOWED_TELEGRAM_ID,
          `<b>⚠️ Ошибка авто-проверки (Cron):</b>\n<code>${escapeHtml(errorText(error))}</code>`
        );
      })
    );
  },

  /** Вебхук Telegram и ручной запуск проверки. */
  async fetch(request, env, ctx) {
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
        return new Response('403 Forbidden', { status: 403 });
      }
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response('OK', { status: 200 });
    }

    // ctx.waitUntil мгновенно возвращает 200 OK в Telegram и исключает таймауты
    // и повторные дублирующие сообщения во время работы ИИ.
    if (update.message) {
      ctx.waitUntil(handleTelegramMessage(env, update.message));
    } else if (update.callback_query) {
      ctx.waitUntil(handleTelegramCallback(env, update.callback_query));
    }

    return new Response('OK', { status: 200 });
  },
};
