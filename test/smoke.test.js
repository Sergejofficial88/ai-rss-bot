import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/**
 * Канарейка от повторения истории с потерей логирования.
 *
 * Правило biome `noConsole` имеет деструктивный unsafe-автофикс: команда
 * `biome check --write --unsafe .` удаляет вызовы console вместе с диагностикой.
 * Однажды это уже произошло — ошибки ИИ и Telegram молча проглатывались,
 * и понять, работает ли Gemini, было невозможно.
 *
 * Если такое случится снова, этот тест упадёт и не даст сделать коммит.
 */
test('логирование в src/ не вырезано форматтером', () => {
  const files = readdirSync(srcDir).filter((name) => name.endsWith('.js'));
  assert.ok(files.length > 0, 'В src/ не найдено ни одного модуля');

  let calls = 0;
  for (const file of files) {
    const code = readFileSync(join(srcDir, file), 'utf8');
    calls += code.match(/console\.(error|warn|log|info|debug)/g)?.length ?? 0;
  }

  assert.ok(
    calls >= 3,
    `Найдено вызовов console.*: ${calls}. Похоже, их удалил автофикс biome ` +
      '(правило noConsole + флаг --unsafe). Логирование обязательно: в Cloudflare Worker ' +
      'console — единственный механизм диагностики.'
  );
});

test('точка входа экспортирует обработчики scheduled и fetch', async () => {
  const module = await import('../src/index.js');
  assert.equal(typeof module.default.scheduled, 'function');
  assert.equal(typeof module.default.fetch, 'function');
});

test('валидация owner/repo отсекает подмену пути и слишком длинные имена', async () => {
  const { isValidRepoName } = await import('../src/utils.js');

  assert.equal(isValidRepoName('XTLS/Xray-core'), true);
  assert.equal(isValidRepoName('my.name/re.po'), true);
  assert.equal(isValidRepoName(`${'a'.repeat(39)}/${'b'.repeat(100)}`), true);

  assert.equal(isValidRepoName('../etc'), false);
  assert.equal(isValidRepoName('a/..'), false);
  assert.equal(isValidRepoName('./x'), false);
  assert.equal(isValidRepoName(`${'a'.repeat(40)}/b`), false);
  assert.equal(isValidRepoName(`a/${'b'.repeat(101)}`), false);
  assert.equal(isValidRepoName('без-слэша'), false);
});

test('chunkText делит длинный текст по лимиту Telegram', async () => {
  const { chunkText } = await import('../src/utils.js');
  const chunks = chunkText('a'.repeat(25), 10);
  assert.deepEqual(
    chunks.map((chunk) => chunk.length),
    [10, 10, 5]
  );
  assert.equal(chunkText('короткий', 100).length, 1);
});

test('модель Gemini берётся из переменной окружения', async () => {
  const { resolveGeminiModel } = await import('../src/ai.js');
  assert.equal(typeof resolveGeminiModel({}), 'string');
  assert.equal(
    resolveGeminiModel({ GEMINI_MODEL: 'gemini-3.5-flash-lite' }),
    'gemini-3.5-flash-lite'
  );
});

test('дубли репозиториев при пагинации GitHub отбрасываются', async () => {
  const edge = (name) => ({
    starredAt: '2026-01-01T00:00:00Z',
    node: {
      nameWithOwner: name,
      description: '',
      url: `https://github.com/${name}`,
      isArchived: false,
      releases: { nodes: [] },
    },
  });

  // Вторая страница намеренно повторяет 'b/two' — так ведёт себя GitHub,
  // когда порядок пагинации оказывается нестабильным.
  const pages = [
    {
      totalCount: 3,
      pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
      edges: [edge('a/one'), edge('b/two')],
    },
    {
      totalCount: 3,
      pageInfo: { hasNextPage: false, endCursor: null },
      edges: [edge('b/two'), edge('c/three')],
    },
  ];

  let call = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const page = pages[Math.min(call, pages.length - 1)];
    call += 1;
    const body = JSON.stringify({ data: { user: { starredRepositories: page } } });
    return {
      ok: true,
      status: 200,
      text: async () => body,
      json: async () => JSON.parse(body),
    };
  };

  try {
    const { fetchStarredWithReleases } = await import('../src/github.js');
    const result = await fetchStarredWithReleases({ GITHUB_USERNAME: 'u', GITHUB_TOKEN: 't' });

    assert.deepEqual(
      result.repos.map((repo) => repo.fullName),
      ['a/one', 'b/two', 'c/three']
    );
    assert.equal(result.skipped, 1, 'Дубль должен быть отброшен и посчитан');
    assert.equal(result.totalCount, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
