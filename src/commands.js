import { answerRepoQuestion } from './ai.js';
import { ASK_TTL_SECONDS, KV_KEYS, REPOS_PER_PAGE } from './config.js';
import { fetchRepoInfo, fetchRepoReadme } from './github.js';
import {
  answerCallbackQuery,
  buildAskButton,
  editTelegramMessage,
  mainMenuKeyboard,
  sendTelegramMessage,
} from './telegram.js';
import { getStarredRepos, runCheck } from './tracker.js';
import { errorText, escapeHtml, formatDateTime, isValidRepoName, truncate } from './utils.js';

const ASK_USAGE =
  'Неверный формат.\n\nИспользуйте:\n<code>/ask owner/repo Ваш вопрос</code>\n\n' +
  'Пример:\n<code>/ask XTLS/Xray-core Какие поддерживаются протоколы?</code>';

const HELP_TEXT =
  '<b>🤖 Бот релизов GitHub и вопросов к ИИ</b>\n\n' +
  'Следит за релизами ваших избранных репозиториев, сообщает о новых проектах и отвечает на вопросы по коду.\n\n' +
  '<b>Что умеет:</b>\n' +
  '• <b>🔄 Проверить релизы</b> — ручной запуск проверки.\n' +
  '• <b>📋 Список Starred-репо</b> — список с постраничной навигацией.\n' +
  '• <b>💬 Спросить ИИ</b> — кнопка под проектом: вопрос пишется прямо в ответ на сообщение.\n' +
  '• <code>/ask owner/repo вопрос</code> — тот же вопрос одной командой.\n' +
  '• <code>/status</code> — состояние бота.';

/** Проверка, что сообщение пришло от владельца бота. */
function isOwner(env, userId) {
  return String(userId) === String(env.ALLOWED_TELEGRAM_ID);
}

/** Обработка текстовых сообщений и нажатий постоянного меню. */
export async function handleTelegramMessage(env, message) {
  const userId = message.from?.id;
  const chatId = message.chat?.id;
  const text = (message.text || '').trim();

  if (!chatId || !isOwner(env, userId)) return;

  // Ответ на сообщение с force_reply — это вопрос по репозиторию.
  if (message.reply_to_message && text && !text.startsWith('/')) {
    const handled = await handleForcedQuestion(env, chatId, userId, text);
    if (handled) return;
  }

  if (text.startsWith('/start') || text.startsWith('/help')) {
    await sendTelegramMessage(env, chatId, HELP_TEXT, mainMenuKeyboard());
    return;
  }

  if (text === '🔄 Проверить релизы' || text === '/check') {
    await sendTelegramMessage(env, chatId, '⏳ Запущена проверка обновлений...');
    try {
      const result = await runCheck(env);
      await sendTelegramMessage(env, chatId, `✅ ${escapeHtml(result)}`, mainMenuKeyboard());
    } catch (error) {
      await sendTelegramMessage(
        env,
        chatId,
        `❌ Ошибка проверки: ${escapeHtml(errorText(error))}`,
        mainMenuKeyboard()
      );
    }
    return;
  }

  if (text === '📋 Список Starred-репо' || text === '/repos') {
    await sendReposPage(env, chatId, 0);
    return;
  }

  if (text === '/status') {
    await sendStatus(env, chatId);
    return;
  }

  if (text.startsWith('/ask')) {
    const parts = text.split(/\s+/);
    if (parts.length < 3) {
      await sendTelegramMessage(env, chatId, ASK_USAGE, mainMenuKeyboard());
      return;
    }
    await answerAboutRepo(env, chatId, parts[1], parts.slice(2).join(' '));
  }
}

/** Обработка inline-кнопок: пагинация списка и запуск режима вопроса. */
export async function handleTelegramCallback(env, callbackQuery) {
  const chatId = callbackQuery.message?.chat?.id;
  const messageId = callbackQuery.message?.message_id;
  const userId = callbackQuery.from?.id;
  const data = callbackQuery.data || '';

  await answerCallbackQuery(env, callbackQuery.id);

  if (!chatId || !isOwner(env, userId)) return;
  if (data === 'noop') return;

  if (data.startsWith('repos:')) {
    const page = Number.parseInt(data.slice('repos:'.length), 10);
    await sendReposPage(env, chatId, Number.isNaN(page) ? 0 : page, messageId);
    return;
  }

  if (data.startsWith('ask_init:')) {
    await startAskFlow(env, chatId, userId, data.slice('ask_init:'.length));
  }
}

/**
 * Запуск режима вопроса: вместо команды для копирования бот открывает
 * у пользователя поле ввода (force_reply).
 */
async function startAskFlow(env, chatId, userId, fullName) {
  if (!isValidRepoName(fullName)) {
    await sendTelegramMessage(env, chatId, '❌ Некорректное имя репозитория.');
    return;
  }

  await env.RELEASES_KV.put(KV_KEYS.ask(chatId, userId), fullName, {
    expirationTtl: ASK_TTL_SECONDS,
  });

  await sendTelegramMessage(
    env,
    chatId,
    `❓ Задайте вопрос по <b>${escapeHtml(fullName)}</b>\n\n` +
      'Просто <b>ответьте на это сообщение</b> — копировать команды не нужно.\n' +
      `<i>Ожидание вопроса: ${Math.round(ASK_TTL_SECONDS / 60)} мин.</i>`,
    { force_reply: true, input_field_placeholder: truncate(`Вопрос по ${fullName}`, 64) }
  );
}

/** Вопрос, отправленный ответом на сообщение бота. Возвращает true, если обработан. */
async function handleForcedQuestion(env, chatId, userId, question) {
  const key = KV_KEYS.ask(chatId, userId);
  const fullName = await env.RELEASES_KV.get(key);
  if (!fullName) return false;

  await env.RELEASES_KV.delete(key);
  await answerAboutRepo(env, chatId, fullName, question);
  return true;
}

/** Получить ответ ИИ по репозиторию и отправить его в чат. */
async function answerAboutRepo(env, chatId, fullName, question) {
  if (!isValidRepoName(fullName)) {
    await sendTelegramMessage(
      env,
      chatId,
      `❌ Некорректное имя репозитория: <code>${escapeHtml(fullName)}</code>\n\n${ASK_USAGE}`,
      mainMenuKeyboard()
    );
    return;
  }

  await sendTelegramMessage(env, chatId, `⏳ Изучаю <b>${escapeHtml(fullName)}</b>...`);

  const info = await fetchRepoInfo(env, fullName);
  if (!info) {
    await sendTelegramMessage(
      env,
      chatId,
      `❌ Репозиторий <b>${escapeHtml(fullName)}</b> не найден на GitHub.`,
      mainMenuKeyboard()
    );
    return;
  }

  const readme = await fetchRepoReadme(env, fullName);
  const answer = await answerRepoQuestion(env, {
    fullName,
    description: info.description,
    readme,
    question,
  });

  const buttons = [{ text: '⭐ Проект на GitHub', url: info.html_url }];
  const askButton = buildAskButton(fullName);
  if (askButton) buttons.push(askButton);

  await sendTelegramMessage(
    env,
    chatId,
    `<b>📦 Проект:</b> ${escapeHtml(fullName)}\n` +
      `<b>❓ Вопрос:</b> ${escapeHtml(question)}\n\n` +
      `<b>🤖 Ответ ИИ:</b>\n${escapeHtml(answer)}`,
    { inline_keyboard: [buttons] }
  );
}

/** Постраничный вывод списка избранного: одно сообщение вместо сообщения на каждый репозиторий. */
async function sendReposPage(env, chatId, page, messageId = null) {
  const repos = await getStarredRepos(env);

  if (repos.length === 0) {
    await sendTelegramMessage(env, chatId, 'У вас нет избранных репозиториев.', mainMenuKeyboard());
    return;
  }

  const totalPages = Math.max(1, Math.ceil(repos.length / REPOS_PER_PAGE));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const slice = repos.slice(safePage * REPOS_PER_PAGE, (safePage + 1) * REPOS_PER_PAGE);

  const lines = [
    `<b>📋 Избранные репозитории</b> — всего ${repos.length}`,
    `Страница ${safePage + 1} из ${totalPages}`,
  ];
  const rows = [];

  for (const repo of slice) {
    lines.push('', `<b>⭐ ${escapeHtml(repo.fullName)}</b>`);
    const starDate = repo.starredAt ? `Добавлено: ${formatDateTime(repo.starredAt)}` : '';
    const description = repo.description
      ? escapeHtml(truncate(repo.description, 150))
      : 'Без описания';
    lines.push(description);
    if (starDate) lines.push(`<i>${escapeHtml(starDate)}</i>`);

    const row = [{ text: '⭐ Открыть', url: repo.url }];
    const askButton = buildAskButton(repo.fullName);
    if (askButton) row.push(askButton);
    rows.push(row);
  }

  const navigation = [];
  if (safePage > 0) navigation.push({ text: '◀ Назад', callback_data: `repos:${safePage - 1}` });
  navigation.push({ text: `${safePage + 1} / ${totalPages}`, callback_data: 'noop' });
  if (safePage < totalPages - 1) {
    navigation.push({ text: 'Вперёд ▶', callback_data: `repos:${safePage + 1}` });
  }
  rows.push(navigation);

  const text = lines.join('\n');
  const keyboard = { inline_keyboard: rows };

  if (messageId) {
    await editTelegramMessage(env, chatId, messageId, text, keyboard);
    return;
  }
  await sendTelegramMessage(env, chatId, text, keyboard);
}

/** Краткий отчёт о состоянии бота. */
async function sendStatus(env, chatId) {
  const lastRun = await env.RELEASES_KV.get(KV_KEYS.lastRun);

  let repoCount = '—';
  try {
    repoCount = String((await getStarredRepos(env)).length);
  } catch (_error) {}

  const lines = [
    '<b>📊 Состояние бота</b>',
    '',
    `• Избранных репозиториев: <b>${escapeHtml(repoCount)}</b>`,
    `• Последняя проверка: <b>${escapeHtml(lastRun ? formatDateTime(lastRun) : 'ещё не было')}</b>`,
    `• ИИ: <b>${env.GEMINI_API_KEY ? 'Gemini + Workers AI (резерв)' : 'Workers AI'}</b>`,
    '• Расписание: каждые 15 минут',
  ];

  await sendTelegramMessage(env, chatId, lines.join('\n'), mainMenuKeyboard());
}
