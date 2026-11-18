# ShopList

Multi-tenant inventory management on Cloudflare Workers (Hono), one SQLite Durable Object per business, D1 control plane, React + Vite web app.

Live: https://shoplist-v2.technology1.workers.dev

```bash
npm install
npm test          # API tests in the Workers runtime
npm run typecheck
npm run dev:api   # local Worker
```

Docs live in [docs/](docs/README.md): plan, architecture, API, security, operations, owner handoff.
