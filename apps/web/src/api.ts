export interface ProblemBody {
  type?: string;
  title?: string;
  status: number;
  detail?: string;
  instance?: string;
  errors?: { field?: string; code: string; message?: string }[];
  current?: unknown;
}

/** An API error with the server's plain-language message, safe to show to the user. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;
  readonly errors: NonNullable<ProblemBody['errors']>;
  readonly current?: unknown;

  constructor(problem: ProblemBody) {
    super(problem.detail || problem.title || 'Something went wrong.');
    this.status = problem.status;
    this.code = (problem.type ?? '').split('/').pop() ?? 'error';
    this.requestId = problem.instance;
    this.errors = problem.errors ?? [];
    this.current = problem.current;
  }
}

export interface RequestOptions {
  body?: unknown;
  /** Product version for optimistic locking (sent as If-Match). */
  ifMatch?: number;
  /** Stable per user action, so a retry never repeats it. */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export const newKey = () => crypto.randomUUID();

export async function api<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.ifMatch !== undefined) headers['if-match'] = `"${opts.ifMatch}"`;
  if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;

  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      signal: opts.signal,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiError({ status: 0, type: 'network', detail: 'Cannot reach ShopList. Check your connection and try again.' });
  }

  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) throw new ApiError((json as ProblemBody | null) ?? { status: res.status, detail: res.statusText });
  return json as T;
}
