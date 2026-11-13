/** RFC 9457 problem details. */
export interface Problem {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
  errors?: { field?: string; code: string; message?: string }[];
  current?: unknown;
}

const TITLES: Record<number, string> = {
  400: 'Bad request',
  401: 'Not signed in',
  403: 'Not allowed',
  404: 'Not found',
  409: 'Conflict',
  412: 'Precondition failed',
  413: 'Payload too large',
  422: 'Unprocessable',
  428: 'Precondition required',
  429: 'Too many requests',
  500: 'Server error',
  503: 'Unavailable',
};

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string,
    readonly extra: Pick<Problem, 'errors' | 'current'> = {},
  ) {
    super(detail);
  }

  toProblem(instance?: string): Problem {
    return {
      type: `https://shoplist.dev/errors/${this.code.replaceAll('_', '-')}`,
      title: TITLES[this.status] ?? 'Error',
      status: this.status,
      detail: this.detail,
      instance,
      ...this.extra,
    };
  }
}

/** What the Durable Object returns across RPC instead of throwing (error properties do not survive RPC). */
export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; code: string; detail: string; extra?: Pick<Problem, 'errors' | 'current'> };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });

/** Unwraps a DO result in the Worker, turning failures into AppError. */
export function unwrap<T>(r: Result<T>): T {
  if (r.ok) return r.value;
  throw new AppError(r.status, r.code, r.detail, r.extra);
}

export const problemResponse = (p: Problem) =>
  new Response(JSON.stringify(p), { status: p.status, headers: { 'content-type': 'application/problem+json' } });
