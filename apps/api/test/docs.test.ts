import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { DOCS } from '../src/docs';
import { ROUTES } from '../src/index';
import { ORIGIN, ip } from './helpers';

describe('API documentation', () => {
  it('documents every route, and nothing that does not exist', () => {
    const real = new Set(ROUTES.map((r) => `${r.method} ${r.path}`));
    expect(ROUTES.filter((r) => !DOCS[`${r.method} ${r.path}`]).map((r) => `${r.method} ${r.path}`), 'routes missing documentation').toEqual([]);
    expect(Object.keys(DOCS).filter((k) => !real.has(k)), 'documentation for routes that do not exist').toEqual([]);
  });

  it('serves a valid OpenAPI 3.1 description with security, headers and body schemas', async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/v1/openapi.json`, { headers: { 'cf-connecting-ip': ip() } });
    expect(res.status).toBe(200);
    const spec: any = await res.json();
    expect(spec.openapi).toBe('3.1.0');
    expect(Object.keys(spec.paths).length).toBeGreaterThan(40);
    const create = spec.paths['/orgs/{orgId}/products'].post;
    expect(create.requestBody.content['application/json'].schema.properties.sku.maxLength).toBe(64);
    expect(create.parameters.map((p: any) => p.name)).toEqual(expect.arrayContaining(['orgId', 'Idempotency-Key']));
    expect(create.security).toEqual([{ session: [] }, { apiKey: [] }]);
    const patch = spec.paths['/orgs/{orgId}/products/{id}'].patch;
    expect(patch.parameters.some((p: any) => p.name === 'If-Match' && p.required)).toBe(true);
    expect(spec.paths['/health'].get.security).toEqual([]);
    expect(spec.paths['/orgs/{orgId}/api-keys'].get.security).toEqual([{ session: [] }]); // keys cannot manage keys
    const list = spec.paths['/orgs/{orgId}/products'].get;
    expect(list.parameters.map((p: any) => p.name)).toEqual(expect.arrayContaining(['q', 'stock', 'cursor', 'limit', 'sort']));
    // every operation says who can call it
    for (const methods of Object.values<any>(spec.paths)) for (const op of Object.values<any>(methods)) expect(op['x-access']).toBeTruthy();
  });

  it('serves a readable page with a nonce-only style policy and no scripts', async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/docs`, { headers: { 'cf-connecting-ip': ip() } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const csp = res.headers.get('content-security-policy')!;
    const nonce = csp.match(/'nonce-([^']+)'/)![1];
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain('unsafe-inline');
    const html = await res.text();
    expect(html).toContain(`<style nonce="${nonce}">`);
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('POST');
    expect(html).toContain('/orgs/{orgId}/orders/{id}/ship');
    expect(html).toContain('If-Match');
    const second = await SELF.fetch(`${ORIGIN}/api/docs`, { headers: { 'cf-connecting-ip': ip() } });
    expect(second.headers.get('content-security-policy')).not.toBe(csp); // fresh nonce each time
  });
});
