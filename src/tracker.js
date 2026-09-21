import { analyzeNewRepo, analyzeRelease } from './ai.js';
import {
  KV_KEYS,
  MAX_AI_CALLS_PER_RUN,
  MAX_RELEASE_NOTICES_PER_RUN,
  MAX_REPO_NOTICES_PER_RUN,
  REPOS_CACHE_TTL_SECONDS,
} from './config.js';
import { fetchLatestReleaseBody, fetchStarredWithReleases } from './github.js';
import { buildAskButton, mainMenuKeyboard, sendTelegramMessage } from './telegram.js';
import { escapeHtml, formatDateTime, mapLimit, nowIso, truncate } from './utils.js';

/**
 * Список избранного с кэшем в KV.
 * Благодаря кэшу навигация по страницам списка не обращается к GitHub на каждое нажатие.
 */
export async function getStarredRepos(env, forceRefresh = false) {
  if (!forceRefresh) {
    const cached = await env.RELEASES_KV.get(KV_KEYS.reposCache, 'json');
    if (Array.isArray(cached)) return cached;
  }

  const repos = await fetchStarredWithReleases(env);
  await env.RELEASES_KV.put(KV_KEYS.reposCache, JSON.stringify(repos), {
    expirationTtl: REPOS_CACHE_TTL_SECONDS,
  });
  return repos;
}

/** Сброс кэша списка — вызывается после проверки, если состав избранного изменился. */
export async function invalidateReposCache(env) {
  await env.RELEASES_KV.delete(KV_KEYS.reposCache);
}

/**
 * Основная проверка: новые избранные проекты и новые релизы.
 * Возвращает текстовый отчёт (используется в /run и при ручной проверке).
 */
export async function runCheck(env, { silent = false } = {}) {
  const repos = await fetchStarredWithReleases(env);
  const isBaseline = !(await env.RELEASES_KV.get(KV_KEYS.initialized));

  const newRepos = [];
  const newReleases = [];

  // Обходим по 5 репозиториев: у Workers лимит в 6 одновременных соединений.
  await mapLimit(repos, 5, async (repo) => {
    const known = await env.RELEASES_KV.get(KV_KEYS.starred(repo.fullName));
    if (!known) {
      await env.RELEASES_KV.put(KV_KEYS.starred(repo.fullName), 'true');
      newRepos.push(repo);
    }

    const release = repo.release;
    if (!release) return;

    const savedId = await env.RELEASES_KV.get(KV_KEYS.release(repo.fullName));
    if (savedId === release.id) return;

    await env.RELEASES_KV.put(KV_KEYS.release(repo.fullName), release.id);

    // Релиз анонсируем только для уже известного проекта — иначе это шум первого запуска.
    if (known) newReleases.push({ repo, release });
  });

  await env.RELEASES_KV.put(KV_KEYS.initialized, 'true');
  await env.RELEASES_KV.put(KV_KEYS.lastRun, nowIso());
  await invalidateReposCache(env);

  // Первый запуск после обновления: молча фиксируем состояние и не заваливаем чат уведомлениями.
  if (isBaseline) {
    if (!silent && newRepos.length > 0) {
      const list = newRepos.map((repo) => `• ${escapeHtml(repo.fullName)}`).join('\n');
      await sendTelegramMessage(
        env,
        env.ALLOWED_TELEGRAM_ID,
        `<b>✅ База инициализирована</b>\n\nВзято под наблюдение: <b>${newRepos.length}</b> репозиториев.\n` +
          'Уведомления по ним начнут приходить при выходе новых релизов.\n\n' +
          list,
        mainMenuKeyboard()
      );
    }
    return `Базовая инициализация: ${newRepos.length} репозиториев, рассылка не выполнялась.`;
  }

  let aiCalls = 0;
  const takeAiCall = () => {
    if (aiCalls >= MAX_AI_CALLS_PER_RUN) return false;
    aiCalls += 1;
    return true;
  };

  // 1. Новые избранные проекты.
  for (const repo of newRepos.slice(0, MAX_REPO_NOTICES_PER_RUN)) {
    let summary = escapeHtml(truncate(repo.description || 'Описание отсутствует', 400));

    if (takeAiCall()) {
      try {
        const analysis = await analyzeNewRepo(env, repo);
        if (analysis) summary = escapeHtml(analysis);
      } catch (_error) {}
    }

    const buttons = [{ text: '⭐ Проект на GitHub', url: repo.url }];
    const askButton = buildAskButton(repo.fullName);
    if (askButton) buttons.push(askButton);

    await sendTelegramMessage(
      env,
      env.ALLOWED_TELEGRAM_ID,
      `<b>⭐ Добавлен новый избранный проект: ${escapeHtml(repo.fullName)}</b>\n\n` +
        `<b>🤖 Обзор ИИ:</b>\n${summary}`,
      { inline_keyboard: [buttons] }
    );
  }

  // 2. Новые релизы.
  for (const { repo, release } of newReleases.slice(0, MAX_RELEASE_NOTICES_PER_RUN)) {
    let analysis = '';

    if (takeAiCall()) {
      try {
        const body = await fetchLatestReleaseBody(env, repo.fullName);
        analysis = await analyzeRelease(env, repo, release, body);
      } catch (_error) {}
    }

    analysis = analysis
      ? escapeHtml(analysis)
      : `<b>📌 О проекте:</b> ${escapeHtml(truncate(repo.description || 'описание отсутствует', 300))}`;

    const rows = [
      [
        { text: '🔗 Релиз', url: release.url },
        { text: '⭐ Проект', url: repo.url },
      ],
    ];
    const askButton = buildAskButton(repo.fullName);
    if (askButton) rows.push([askButton]);

    await sendTelegramMessage(
      env,
      env.ALLOWED_TELEGRAM_ID,
      `<b>🚀 Новый релиз: ${escapeHtml(repo.fullName)}</b> (<code>${escapeHtml(release.tag)}</code>)\n` +
        `🕐 ${formatDateTime(release.publishedAt)}\n\n${analysis}`,
      { inline_keyboard: rows }
    );
  }

  // 3. Остаток за прогон — одним дайджестом: это экономит внешние запросы Telegram.
  const overflowRepos = newRepos.slice(MAX_REPO_NOTICES_PER_RUN);
  const overflowReleases = newReleases.slice(MAX_RELEASE_NOTICES_PER_RUN);

  if (overflowRepos.length > 0 || overflowReleases.length > 0) {
    const lines = ['<b>📬 Остальные обновления за этот прогон</b>'];

    if (overflowRepos.length > 0) {
      lines.push('', '<b>⭐ Новые проекты:</b>');
      for (const repo of overflowRepos) lines.push(`• ${escapeHtml(repo.fullName)}`);
    }

    if (overflowReleases.length > 0) {
      lines.push('', '<b>🚀 Новые релизы:</b>');
      for (const { repo, release } of overflowReleases) {
        lines.push(`• ${escapeHtml(repo.fullName)} — <code>${escapeHtml(release.tag)}</code>`);
      }
    }

    await sendTelegramMessage(env, env.ALLOWED_TELEGRAM_ID, lines.join('\n'), mainMenuKeyboard());
  }

  return `Проверено: ${repos.length}, новых проектов: ${newRepos.length}, новых релизов: ${newReleases.length}`;
}
