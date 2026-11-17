import type { Bindings } from './env';

export type UsageEnv = Pick<Bindings, 'DB'> & Partial<Pick<Bindings, 'CF_ANALYTICS_TOKEN' | 'CF_ACCOUNT_ID' | 'ANALYTICS'>>;

/** Cloudflare's free-plan daily allowances. Worker CPU is per request, in microseconds. */
export const FREE_LIMITS = { requests: 100_000, d1RowsWritten: 100_000, d1RowsRead: 5_000_000, doRequests: 100_000, queueOps: 10_000 } as const;
export const CPU_LIMIT_US = 10_000;
export const WARN_AT = 0.7;

export interface UsageDay { date: string; requests: number; errors: number; cpuP50Us: number; cpuP99Us: number; d1RowsRead: number; d1RowsWritten: number; doRequests: number; queueOps: number }
export type UsageMetric = 'requests' | 'd1RowsWritten' | 'd1RowsRead' | 'doRequests' | 'queueOps';
export const METRIC_LABEL: Record<UsageMetric, string> = { requests: 'Worker requests', d1RowsWritten: 'Database rows written', d1RowsRead: 'Database rows read', doRequests: 'Business-storage requests', queueOps: 'Queue operations' };

const QUERY = `query($a:String!,$s:Date!){ viewer { accounts(filter:{accountTag:$a}) {
  w: workersInvocationsAdaptive(limit:100, filter:{date_geq:$s}, orderBy:[date_ASC]) { dimensions{date} sum{requests errors} quantiles{cpuTimeP50 cpuTimeP99} }
  d: d1AnalyticsAdaptiveGroups(limit:100, filter:{date_geq:$s}, orderBy:[date_ASC]) { dimensions{date} sum{rowsRead rowsWritten} }
  o: durableObjectsInvocationsAdaptiveGroups(limit:100, filter:{date_geq:$s}, orderBy:[date_ASC]) { dimensions{date} sum{requests} }
  q: queueMessageOperationsAdaptiveGroups(limit:100, filter:{date_geq:$s}, orderBy:[date_ASC]) { dimensions{date} sum{billableOperations} }
}}}`;

type Grp<S> = { dimensions: { date: string }; sum?: S; quantiles?: { cpuTimeP50: number; cpuTimeP99: number } }[];
interface Raw { data?: { viewer: { accounts: { w: Grp<{ requests: number; errors: number }>; d: Grp<{ rowsRead: number; rowsWritten: number }>; o: Grp<{ requests: number }>; q: Grp<{ billableOperations: number }> }[] } }; errors?: { message: string }[] | null }

/** Folds Cloudflare's four result sets into one row per day. Pure, so it can be tested on recorded responses. */
export function foldUsage(raw: Raw): UsageDay[] {
  const acc = raw.data?.viewer.accounts[0];
  if (!acc) return [];
  const days = new Map<string, UsageDay>();
  const day = (date: string) => { let d = days.get(date); if (!d) { d = { date, requests: 0, errors: 0, cpuP50Us: 0, cpuP99Us: 0, d1RowsRead: 0, d1RowsWritten: 0, doRequests: 0, queueOps: 0 }; days.set(date, d); } return d; };
  for (const r of acc.w ?? []) { const d = day(r.dimensions.date); d.requests += r.sum?.requests ?? 0; d.errors += r.sum?.errors ?? 0; d.cpuP50Us = r.quantiles?.cpuTimeP50 ?? 0; d.cpuP99Us = r.quantiles?.cpuTimeP99 ?? 0; }
  for (const r of acc.d ?? []) { const d = day(r.dimensions.date); d.d1RowsRead += r.sum?.rowsRead ?? 0; d.d1RowsWritten += r.sum?.rowsWritten ?? 0; }
  for (const r of acc.o ?? []) day(r.dimensions.date).doRequests += r.sum?.requests ?? 0;
  for (const r of acc.q ?? []) day(r.dimensions.date).queueOps += r.sum?.billableOperations ?? 0;
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}

let cache: { at: number; days: number; rows: UsageDay[] } | null = null;
export const resetUsageCache = () => { cache = null; };

/** The last `days` days of platform usage from Cloudflare's analytics. Read-only token; cached for 5 minutes. Throws a plain message when it cannot be read. */
export async function fetchUsage(env: UsageEnv, days = 30): Promise<UsageDay[]> {
  if (!env.CF_ANALYTICS_TOKEN || !env.CF_ACCOUNT_ID) throw new Error('Usage numbers are not set up on this server (CF_ANALYTICS_TOKEN and CF_ACCOUNT_ID).');
  if (cache && cache.days === days && Date.now() - cache.at < 300_000) return cache.rows;
  const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query: QUERY, variables: { a: env.CF_ACCOUNT_ID, s: since } }),
  });
  if (!res.ok) throw new Error(`Cloudflare analytics answered ${res.status}.`);
  const raw = (await res.json()) as Raw;
  if (raw.errors?.length) throw new Error('Cloudflare analytics refused the request. Check the token.');
  const rows = foldUsage(raw);
  cache = { at: Date.now(), days, rows };
  return rows;
}

/** Metrics at or above the warning line on the given day. */
export function overLine(d: UsageDay | undefined, at = WARN_AT): { metric: UsageMetric; used: number; limit: number; pct: number }[] {
  if (!d) return [];
  return (Object.keys(FREE_LIMITS) as UsageMetric[])
    .map((metric) => ({ metric, used: d[metric], limit: FREE_LIMITS[metric], pct: d[metric] / FREE_LIMITS[metric] }))
    .filter((x) => x.pct >= at);
}

/** Requests per business over the last day, from Workers Analytics Engine. Empty when the dataset is not available. */
export async function topBusinesses(env: UsageEnv, limit = 20): Promise<{ orgId: string; requests: number; errors: number }[]> {
  if (!env.CF_ANALYTICS_TOKEN || !env.CF_ACCOUNT_ID) return [];
  const sql = `SELECT index1 AS orgId, SUM(_sample_interval) AS requests, SUM(IF(double1 >= 500, _sample_interval, 0)) AS errors FROM shoplist_requests WHERE timestamp > NOW() - INTERVAL '1' DAY GROUP BY orgId ORDER BY requests DESC LIMIT ${Math.min(Math.max(limit, 1), 50)}`;
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`, { method: 'POST', headers: { authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}` }, body: sql });
  if (!res.ok) return [];
  const body = (await res.json()) as { data?: { orgId: string; requests: number | string; errors: number | string }[] };
  return (body.data ?? []).map((r) => ({ orgId: r.orgId, requests: Number(r.requests), errors: Number(r.errors) }));
}
