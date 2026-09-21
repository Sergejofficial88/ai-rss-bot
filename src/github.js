import { GITHUB_API_URL, GITHUB_GRAPHQL_URL } from './config.js';
import { truncate } from './utils.js';

/** Заголовки для GitHub API. */
export function githubHeaders(env) {
  const headers = {
    'User-Agent': 'realise-rss-ai',
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  }
  return headers;
}

/**
 * Один GraphQL-запрос отдаёт сразу и список избранного, и последний релиз каждого проекта.
 * Это ключевая оптимизация: вместо отдельного REST-запроса на каждый репозиторий
 * (что превысило бы лимит в 50 внешних запросов Workers Free) — один запрос на 100 репозиториев.
 */
const STARRED_QUERY = `
  query StarredRepositories($login: String!, $cursor: String) {
    user(login: $login) {
      starredRepositories(
        first: 100
        after: $cursor
        orderBy: { field: STARRED_AT, direction: DESC }
      ) {
        totalCount
        pageInfo { hasNextPage endCursor }
        edges {
          starredAt
          node {
            nameWithOwner
            description
            url
            isArchived
            releases(first: 5, orderBy: { field: CREATED_AT, direction: DESC }) {
              nodes { id tagName name url publishedAt isDraft isPrerelease }
            }
          }
        }
      }
    }
  }
`;

/** Последний стабильный релиз — без черновиков и пре-релизов (как REST `/releases/latest`). */
function pickLatestRelease(nodes) {
  if (!Array.isArray(nodes)) return null;
  const release = nodes.find((node) => node && !node.isDraft && !node.isPrerelease);
  if (!release) return null;
  return {
    id: release.id,
    tag: release.tagName,
    name: release.name || release.tagName,
    url: release.url,
    publishedAt: release.publishedAt,
  };
}

/**
 * Список избранных репозиториев вместе с их последними релизами.
 *
 * Возвращает объект:
 *   repos      — массив репозиториев (без повторов);
 *   totalCount — сколько избранного всего по данным GitHub;
 *   skipped    — сколько дублей отброшено (диагностика пагинации).
 */
export async function fetchStarredWithReleases(env) {
  const login = env.GITHUB_USERNAME;
  if (!login) throw new Error('Не задан GITHUB_USERNAME');

  const repos = [];
  const seen = new Set();
  let skipped = 0;
  let totalCount = 0;
  let cursor = null;

  // Защита от бесконечного цикла: 10 страниц × 100 = 1000 репозиториев.
  for (let page = 0; page < 10; page++) {
    const response = await fetch(GITHUB_GRAPHQL_URL, {
      method: 'POST',
      headers: { ...githubHeaders(env), 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: STARRED_QUERY, variables: { login, cursor } }),
    });

    if (!response.ok) {
      const body = truncate(await response.text(), 200);
      throw new Error(`GitHub GraphQL: HTTP ${response.status} — ${body}`);
    }

    const payload = await response.json();
    if (Array.isArray(payload.errors) && payload.errors.length > 0) {
      throw new Error(`GitHub GraphQL: ${payload.errors.map((e) => e.message).join('; ')}`);
    }

    const connection = payload.data?.user?.starredRepositories;
    if (!connection) {
      throw new Error(`GitHub: пользователь «${login}» не найден или недоступен`);
    }

    totalCount = connection.totalCount ?? totalCount;

    for (const edge of connection.edges ?? []) {
      const node = edge?.node;
      const fullName = node?.nameWithOwner;
      if (!fullName) continue;

      // Защита от повторов: при пагинации по нестабильному порядку GitHub
      // может вернуть один и тот же репозиторий дважды.
      if (seen.has(fullName)) {
        skipped += 1;
        continue;
      }
      seen.add(fullName);

      repos.push({
        fullName,
        description: node.description || '',
        url: node.url,
        archived: Boolean(node.isArchived),
        starredAt: edge.starredAt ?? null,
        release: pickLatestRelease(node.releases?.nodes),
      });
    }

    if (!connection.pageInfo?.hasNextPage) break;
    cursor = connection.pageInfo.endCursor;
  }

  if (skipped > 0) {
    console.error(`GitHub вернул дубли: отброшено ${skipped}, уникальных ${repos.length}`);
  }

  return { repos, totalCount, skipped };
}

/** Полный текст последнего релиза — запрашивается только для действительно новых релизов. */
export async function fetchLatestReleaseBody(env, fullName) {
  const response = await fetch(`${GITHUB_API_URL}/repos/${fullName}/releases/latest`, {
    headers: githubHeaders(env),
  });
  if (!response.ok) return '';
  const data = await response.json();
  return data.body || '';
}

/** Информация о репозитории — для режима вопросов к ИИ. */
export async function fetchRepoInfo(env, fullName) {
  const response = await fetch(`${GITHUB_API_URL}/repos/${fullName}`, {
    headers: githubHeaders(env),
  });
  if (!response.ok) return null;
  return response.json();
}

/** Текст README — для режима вопросов к ИИ. */
export async function fetchRepoReadme(env, fullName) {
  const response = await fetch(`${GITHUB_API_URL}/repos/${fullName}/readme`, {
    headers: { ...githubHeaders(env), Accept: 'application/vnd.github.v3.raw' },
  });
  if (!response.ok) return '';
  return response.text();
}
