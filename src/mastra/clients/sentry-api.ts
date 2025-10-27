import type { RequestInit } from 'node-fetch';

export interface SentryConfig {
  baseUrl: string;           // 例: https://us.sentry.io または self-host
  organizationSlug: string;  // 例: "mov-inc"
  authToken: string;         // Sentry User Auth Token (Bearer)
}

function authHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Organization Issues 検索
 * GET /api/0/organizations/{org}/issues/?project=<id>&query=...&limit=...
 * docs: https://docs.sentry.io/api/events/list-an-organizations-issues/
 *
 * 注意: project パラメータは数値のプロジェクトIDである必要があります
 */
export async function searchIssues(
  cfg: SentryConfig,
  params: {
    project: string; // プロジェクトID (数値文字列)
    query: string;   // e.g. 'environment:production is:unresolved lastSeen:>=-14d'
    limit?: number;  // default 50
    cursor?: string;
  }
) {
  const url = new URL(`/api/0/organizations/${cfg.organizationSlug}/issues/`, cfg.baseUrl);
  url.searchParams.set('project', params.project);
  url.searchParams.set('query', params.query);
  if (params.limit) url.searchParams.set('limit', String(params.limit));
  if (params.cursor) url.searchParams.set('cursor', params.cursor);

  const res = await fetch(url.toString(), { headers: authHeaders(cfg.authToken) } as RequestInit);
  if (!res.ok) throw new Error(`Sentry issues fetch failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const link = res.headers.get('link') ?? undefined; // ページネーション用
  return { data, link };
}

/**
 * Discover Events（テーブル形式）検索
 * GET /api/0/organizations/{org}/events/
 * docs: https://docs.sentry.io/api/discover/query-discover-events-in-table-format/
 */
export async function searchEvents(
  cfg: SentryConfig,
  params: {
    project: string;          // slug or id
    query: string;            // Discover クエリ
    fields: string[];         // 例: ['id','timestamp','message','issue.id']
    sort?: string;            // 例: '-timestamp'
    perPage?: number;         // 例: 50
    statsPeriod?: string;     // 例: '14d' （または start/end を使う実装に拡張可）
  }
) {
  const url = new URL(`/api/0/organizations/${cfg.organizationSlug}/events/`, cfg.baseUrl);
  url.searchParams.set('project', params.project);
  url.searchParams.set('query', params.query);
  for (const f of params.fields) url.searchParams.append('field', f);
  if (params.sort) url.searchParams.set('sort', params.sort);
  if (params.perPage) url.searchParams.set('per_page', String(params.perPage));
  if (params.statsPeriod) url.searchParams.set('statsPeriod', params.statsPeriod);

  const res = await fetch(url.toString(), { headers: authHeaders(cfg.authToken) } as RequestInit);
  if (!res.ok) throw new Error(`Sentry events fetch failed: ${res.status} ${await res.text()}`);
  return res.json();
}
