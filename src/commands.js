import { answerRepoQuestion, listGeminiModels, resolveGeminiModel, testGemini } from './ai.js';
import {
  ASK_TTL_SECONDS,
  CALLBACK_DATA_LIMIT,
  CARD_TTL_SECONDS,
  KV_KEYS,
  REPOS_PER_PAGE,
} from './config.js';
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
  '• <b>📋 Список Starred-репо</b> — список с карточками проектов.\n' +
  '• <b>💬 Спросить ИИ</b> — открывает поле ввода: вопрос пишется прямо в ответ на сообщение.\n' +
  '• <code>/ask owner/repo вопрос</code> — тот же вопрос одной командой.\n' +
  '• <code>/status</code> — состояние бота.\n' +
  '• <code>/ai</code> — проверка Gemini: какая модель отвечает и какие доступны.';

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

  if (text === '/ai') {
    await sendAiStatus(env, chatId);
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

/** Обработка inline-кнопок: навигация, карточки и запуск режима вопроса. */
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

  if (data.startsWith('repo:')) {
    await openRepoCard(env, chatId, messageId, data.slice('repo:'.length));
    return;
  }

  if (data.startsWith('repoi:')) {
    const [, page, index] = data.split(':');
    await openRepoCardByIndex(
      env,
      chatId,
      messageId,
      Number.parseInt(page, 10) || 0,
      Number.parseInt(index, 10) || 0
    );
    return;
  }

  // Вопрос по репозиторию, открытому в карточке: имя берём из KV по id сообщения.
  if (data === 'ask_ctx') {
    const fullName = await env.RELEASES_KV.get(KV_KEYS.card(chatId, messageId));
    if (!fullName) {
      await sendTelegramMessage(
        env,
        chatId,
        '⌛️ Контекст устарел. Откройте список заново: /repos',
        mainMenuKeyboard()
      );
      return;
    }
    await startAskFlow(env, chatId, userId, fullName);
    return;
  }

  // Старые сообщения с именем репозитория прямо в кнопке.
  if (data.startsWith('ask_init:') || data.startsWith('prompt_ask:')) {
    const fullName = data.slice(data.indexOf(':') + 1);
    await startAskFlow(env, chatId, userId, fullName);
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

  const provider = answer.provider ? `\n\n<i>🤖 ${escapeHtml(answer.provider)}</i>` : '';

  await sendTelegramMessage(
    env,
    chatId,
    `<b>📦 Проект:</b> ${escapeHtml(fullName)}\n` +
      `<b>❓ Вопрос:</b> ${escapeHtml(question)}\n\n` +
      `<b>🤖 Ответ ИИ:</b>\n${escapeHtml(answer.text)}` +
      provider,
    { inline_keyboard: [buttons] }
  );
}

/**
 * Постраничный список избранного.
 * У каждого репозитория своя кнопка с его именем — так видно,
 * какая кнопка к какому проекту относится.
 */
async function sendReposPage(env, chatId, page, messageId = null) {
  const { repos, totalCount, skipped } = await getStarredRepos(env);

  if (repos.length === 0) {
    await sendTelegramMessage(env, chatId, 'У вас нет избранных репозиториев.', mainMenuKeyboard());
    return;
  }

  const totalPages = Math.max(1, Math.ceil(repos.length / REPOS_PER_PAGE));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const start = safePage * REPOS_PER_PAGE;
  const slice = repos.slice(start, start + REPOS_PER_PAGE);

  const heading = [`<b>📋 Избранные репозитории</b> — ${repos.length}`];
  if (typeof totalCount === 'number' && totalCount !== repos.length) {
    heading.push(`<i>GitHub сообщает: ${totalCount}</i>`);
  }
  if (skipped > 0) heading.push(`<i>Отброшено дублей: ${skipped}</i>`);
  heading.push(`Страница ${safePage + 1} из ${totalPages}`, '');
  heading.push('<i>Нажмите на репозиторий — откроется карточка с описанием и действиями.</i>');

  const rows = slice.map((repo, index) => {
    const byName = `repo:${repo.fullName}`;
    const callbackData =
      byName.length <= CALLBACK_DATA_LIMIT ? byName : `repoi:${safePage}:${index}`;
    return [{ text: `📦 ${truncate(repo.fullName, 40)}`, callback_data: callbackData }];
  });

  const navigation = [];
  if (safePage > 0) navigation.push({ text: '◀ Назад', callback_data: `repos:${safePage - 1}` });
  navigation.push({ text: `${safePage + 1} / ${totalPages}`, callback_data: 'noop' });
  if (safePage < totalPages - 1) {
    navigation.push({ text: 'Вперёд ▶', callback_data: `repos:${safePage + 1}` });
  }
  rows.push(navigation);

  const text = heading.join('\n');
  const keyboard = { inline_keyboard: rows };

  if (messageId) {
    await editTelegramMessage(env, chatId, messageId, text, keyboard);
    return;
  }
  await sendTelegramMessage(env, chatId, text, keyboard);
}

/** Карточка репозитория: описание, дата добавления, последний релиз и действия. */
async function showRepoCard(env, chatId, messageId, repo, page) {
  const lines = [`<b>📦 ${escapeHtml(repo.fullName)}</b>`, ''];
  lines.push(escapeHtml(truncate(repo.description || 'Без описания', 400)), '');

  if (repo.starredAt) {
    lines.push(`⭐ <i>Добавлено: ${escapeHtml(formatDateTime(repo.starredAt))}</i>`);
  }
  if (repo.release) {
    lines.push(
      `🚀 <i>Последний релиз: ${escapeHtml(repo.release.tag)} · ${escapeHtml(formatDateTime(repo.release.publishedAt))}</i>`
    );
  } else {
    lines.push('🚀 <i>Релизов пока нет</i>');
  }

  const keyboard = {
    inline_keyboard: [
      [{ text: '⭐ Открыть на GitHub', url: repo.url }],
      [{ text: '💬 Спросить ИИ', callback_data: 'ask_ctx' }],
      [{ text: '◀ К списку', callback_data: `repos:${page}` }],
    ],
  };

  const text = lines.join('\n');

  if (messageId) {
    await env.RELEASES_KV.put(KV_KEYS.card(chatId, messageId), repo.fullName, {
      expirationTtl: CARD_TTL_SECONDS,
    });
    await editTelegramMessage(env, chatId, messageId, text, keyboard);
    return;
  }

  const sent = await sendTelegramMessage(env, chatId, text, keyboard);
  const newMessageId = sent?.result?.message_id;
  if (newMessageId) {
    await env.RELEASES_KV.put(KV_KEYS.card(chatId, newMessageId), repo.fullName, {
      expirationTtl: CARD_TTL_SECONDS,
    });
  }
}

/** Открыть карточку по имени репозитория. */
async function openRepoCard(env, chatId, messageId, fullName) {
  if (!isValidRepoName(fullName)) {
    await sendTelegramMessage(env, chatId, '❌ Некорректное имя репозитория.');
    return;
  }

  const { repos } = await getStarredRepos(env);
  const index = repos.findIndex((repo) => repo.fullName === fullName);
  if (index < 0) {
    await sendTelegramMessage(
      env,
      chatId,
      `❌ Репозиторий <b>${escapeHtml(fullName)}</b> больше не в избранном.`,
      mainMenuKeyboard()
    );
    return;
  }

  await showRepoCard(env, chatId, messageId, repos[index], Math.floor(index / REPOS_PER_PAGE));
}

/** Открыть карточку по позиции на странице (для слишком длинных имён). */
async function openRepoCardByIndex(env, chatId, messageId, page, index) {
  const { repos } = await getStarredRepos(env);
  const absolute = page * REPOS_PER_PAGE + index;
  const repo = repos[absolute];

  if (!repo) {
    await sendTelegramMessage(
      env,
      chatId,
      '⚠️ Список изменился. Откройте его заново: /repos',
      mainMenuKeyboard()
    );
    return;
  }

  await showRepoCard(env, chatId, messageId, repo, page);
}

/** Краткий отчёт о состоянии бота. */
async function sendStatus(env, chatId) {
  const lastRun = await env.RELEASES_KV.get(KV_KEYS.lastRun);

  const lines = ['<b>📊 Состояние бота</b>', ''];

  try {
    const { repos, totalCount, skipped } = await getStarredRepos(env);
    lines.push(`• Избранных репозиториев: <b>${repos.length}</b>`);
    if (typeof totalCount === 'number' && totalCount !== repos.length) {
      lines.push(`• GitHub сообщает: <b>${totalCount}</b>`);
    }
    if (skipped > 0) lines.push(`• Отброшено дублей: <b>${skipped}</b>`);
  } catch (error) {
    console.error('Не удалось получить список репозиториев:', errorText(error));
    lines.push(`• Избранных репозиториев: <b>ошибка</b> (${escapeHtml(errorText(error))})`);
  }

  lines.push(
    `• Последняя проверка: <b>${escapeHtml(lastRun ? formatDateTime(lastRun) : 'ещё не было')}</b>`,
    `• Модель Gemini: <code>${escapeHtml(resolveGeminiModel(env))}</code>`,
    `• Ключ Gemini: ${env.GEMINI_API_KEY ? '✅ задан' : '❌ не задан'}`,
    '• Расписание: каждые 15 минут',
    '',
    'Подробнее об ИИ: /ai'
  );

  await sendTelegramMessage(env, chatId, lines.join('\n'), mainMenuKeyboard());
}

/** Проверка Gemini: отвечает ли модель и какие модели доступны ключу. */
async function sendAiStatus(env, chatId) {
  const model = resolveGeminiModel(env);

  const lines = [
    '<b>🤖 Состояние ИИ</b>',
    '',
    `• Настроенная модель: <code>${escapeHtml(model)}</code>`,
    `• Ключ Gemini: ${env.GEMINI_API_KEY ? '✅ задан' : '❌ не задан'}`,
    `• Workers AI: ${env.AI ? '✅ доступен' : '❌ недоступен'}`,
  ];

  if (!env.GEMINI_API_KEY) {
    lines.push('', 'Без ключа используется только Workers AI.');
    await sendTelegramMessage(env, chatId, lines.join('\n'), mainMenuKeyboard());
    return;
  }

  await sendTelegramMessage(env, chatId, '⏳ Проверяю связь с Gemini...');

  const test = await testGemini(env);
  lines.push('', '<b>Проверка связи:</b>');

  if (test.ok) {
    lines.push(`✅ Ответ получен за ${test.ms} мс`);
    lines.push(`• Способ: <code>${escapeHtml(test.provider ?? '—')}</code>`);
    if (test.sample) lines.push(`• Ответ: ${escapeHtml(truncate(test.sample, 120))}`);
  } else {
    lines.push('❌ Gemini не ответил — бот использует резервный Workers AI.');
    for (const error of test.errors.slice(0, 4)) {
      lines.push(`• <code>${escapeHtml(truncate(error, 200))}</code>`);
    }
  }

  try {
    const models = await listGeminiModels(env);
    const flashModels = models.filter((name) => name.includes('flash')).slice(0, 12);
    if (flashModels.length > 0) {
      lines.push('', '<b>Доступные flash-модели:</b>');
      for (const name of flashModels) lines.push(`• <code>${escapeHtml(name)}</code>`);
    } else if (models.length > 0) {
      lines.push('', `<i>Ключу доступно моделей: ${models.length}</i>`);
    }
  } catch (error) {
    lines.push('', `Не удалось получить список моделей: ${escapeHtml(errorText(error))}`);
  }

  lines.push(
    '',
    'Смена модели: добавьте переменную <code>GEMINI_MODEL</code> в настройках воркера',
    '(Settings → Variables and secrets → Add → Variable) — без правки кода.'
  );

  await sendTelegramMessage(env, chatId, lines.join('\n'), mainMenuKeyboard());
}
