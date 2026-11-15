# 01 · The access model

This file defines **who exists**, **what each one may do**, **what each one sees**, and **how the
server enforces it**. Every feature file refers back to it.

## 1. Principles

1. **Least privilege by job.** A role gets exactly what its job needs. A sales person does not need
   to change products; a stock keeper does not need to take payments.
2. **Tenant data belongs to the tenant.** A business's products, stock, prices, customers and orders
   are its own. The developer runs the platform but does not read them, except inside a support
   window that the business's admin opens (F19). This is today's rule, made workable.
3. **The admin assigns roles but never defines them.** What a role can do is set in code
   (`ROLE_PERMISSIONS` in `packages/shared`), reviewed and tested. An admin cannot invent a role or
   widen one. This stops "permission creep", where each business slowly builds unsafe custom roles.
4. **The server decides, the screen only follows.** Hiding a button is a convenience. Every rule is
   enforced in the API and proved by a test. A hidden button that a crafted request can still
   trigger counts as a bug.
5. **Everything that changes data is recorded.** Business actions go to the organization's activity
   log (inside its Durable Object). Platform actions go to the platform audit log (D1). Support
   access goes to both.
6. **Fail closed.** An unknown role, permission, setting or mode means "no".
7. **Stay on the Cloudflare free plan.** Each feature lists its cost in requests, writes and storage.

## 2. The four levels

### 2.1 Developer (super admin)

- **Who:** you. Exactly one account, identified by GitHub numeric id `SUPER_ADMIN_GITHUB_ID`.
- **Signs in:** only at `/owner`, with GitHub. A session from any other door (Clerk, passkey) never
  carries developer power, even on the same account. *Built.*
- **Job:** onboard businesses, keep the platform healthy and safe, set limits, help when asked.
- **Cannot:** read a business's data outside a support window, change a business's data at all,
  or appear in a business's member list.
- **Your own test business:** your account may be the admin of a business you made for yourself
  (like the current "Demo"). That membership is ordinary and works through ordinary sessions.
  Developer power and tenant membership never mix in one request.

### 2.2 Admin (business owner)

- **Who:** the owner of one client business. **One per organization.** A second admin is allowed
  only with explicit confirmation (for a co-owner). The last admin can never be removed or demoted.
  *Built.*
- **Job:** run their business on ShopList: team, settings, approvals, money, integrations.
- **Can:** everything inside their own organization.
- **Cannot:** see other businesses, change what a role means, or reach platform tools.

### 2.3 Staff (roles by job)

| Role | Label on screen | The job | Typical person |
|---|---|---|---|
| `manager` | Manager | Runs daily operations | Store or operations manager |
| `sales` | Sales | Sells and fulfils orders | Counter staff, order desk |
| `stock` | Stock keeper | Moves goods | Warehouse or stockroom staff |
| `accountant` | Accountant | Reads numbers, never changes operations | Bookkeeper, auditor (new in F17) |
| `viewer` | Viewer | Looks only | Owner's partner, investor, trainee |

Any staff member can additionally be **limited to some locations** (F9). For example, a stock keeper
at "Warehouse A" can see stock everywhere but can only move stock at Warehouse A.

### 2.4 External (no account)

| Who | Gets | Feature |
|---|---|---|
| A customer | A private link showing one order's status | F24 |
| A supplier | A private link to one purchase order, where they can confirm dispatch | F25 |
| Another system | An API key with narrow scopes | Built; narrower scopes in F18 |

External links are unguessable (32 random bytes), expire, can be revoked, are rate-limited, and
show the minimum: no prices for the supplier other than their own PO, no other orders for the customer.

## 3. Permissions

A **permission** is one capability. Routes declare exactly one. Roles are lists of permissions.

| Permission | Meaning | Today |
|---|---|---|
| `inventory:read` | See products, stock levels, locations, orders, history, dashboard counts | Built |
| `cost:read` | See cost price, margin and inventory value | New (F5) |
| `products:write` | Create, edit, delete, restore products; CSV import | Built |
| `stock:write` | Receive, adjust, transfer, count stock | Built |
| `orders:write` | Create orders, record payment, ship, cancel | Built |
| `customers:read` | See customer details (email, phone, address) | New (F16) |
| `purchasing:write` | Suppliers and purchase orders | New (F13) |
| `counts:assign` | Create and assign count tasks | New (F15) |
| `approvals:decide` | Approve or reject requests in the approval queue | New (F10) |
| `reports:read` | Reports and their exports | New (F12) |
| `team:manage` | Members, invitations, roles, location scoping | Split from `org:manage` (F7) |
| `settings:manage` | Business settings, locations, API keys, webhooks, support grants | Split from `org:manage` (F7) |
| `audit:read` | The organization's activity log | Split from `org:manage` (F7) |
| `org:delete` | Delete the organization | Renamed from `org:owner` (F7) |

### 3.1 The final matrix

| Permission | viewer | sales | stock | accountant | manager | admin |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| inventory:read | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| cost:read | | | | ✓ | ✓ | ✓ |
| customers:read | | ✓ | | ✓ | ✓ | ✓ |
| products:write | | | | | ✓ | ✓ |
| stock:write | | | ✓ | | ✓ | ✓ |
| orders:write | | ✓ | | | ✓ | ✓ |
| purchasing:write | | | | | ✓ | ✓ |
| counts:assign | | | | | ✓ | ✓ |
| approvals:decide | | | | | ✓ | ✓ |
| reports:read | | | | ✓ | ✓ | ✓ |
| audit:read | | | | ✓ | | ✓ |
| team:manage | | | | | | ✓ |
| settings:manage | | | | | | ✓ |
| org:delete | | | | | | ✓ |

Notes on choices that are not obvious:
- **Accountant gets `audit:read`, the manager does not.** The activity log shows who changed what,
  including managers' own changes. An accountant or auditor checking the books needs it; the person
  being audited should not control or browse it. The admin has it anyway.
- **Stock keeper does not get `customers:read`.** They pick and pack against an order number; they
  do not need a customer's email or phone.
- **Manager does not get `team:manage`.** Hiring and role changes stay with the owner. If a business
  wants a manager to invite people, the admin can add a second admin (with confirmation).
- **Some actions need approval even when the permission allows them** (F10). The permission says
  "may ask"; the approval rule says "and someone with `approvals:decide` must agree".

### 3.2 API keys

Keys never get `team:manage`, `settings:manage`, `audit:read` or `org:delete`, whatever their scopes.
Scopes after F18: `read`, `products:write`, `stock:write`, `orders:write`, `reports:read`,
`cost:read`. Old keys with `inventory:write` keep working and mean the three write scopes.

## 4. What each role sees on screen

The sidebar and buttons follow the matrix. Hidden items are also refused by the API.

| Screen / item | viewer | sales | stock | accountant | manager | admin |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Orders list and detail | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| "New order", pay, ship, cancel | | ✓ | | | ✓ | ✓ |
| Customer email, phone, address on orders | | ✓ | | ✓ | ✓ | ✓ |
| Products list | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Cost, margin, inventory value | | | | ✓ | ✓ | ✓ |
| New, edit, delete, import products | | | | | ✓ | ✓ |
| Adjust, receive, transfer, count | | | ✓ | | ✓ | ✓ |
| Stock history | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Purchasing (suppliers, POs, reorder) | | | view POs to receive | ✓ view | ✓ | ✓ |
| Count tasks | | | my tasks | | assign and review | assign and review |
| Approvals queue | | my requests | my requests | | decide | decide |
| Reports | | | | ✓ | ✓ | ✓ |
| Activity log | | | | ✓ | | ✓ |
| Settings: my profile, sessions, passkeys, notifications | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Settings: team, invitations | | | | | | ✓ |
| Settings: business, locations, API keys, webhooks, backup, support access, delete | | | | | | ✓ |
| Platform console (`/admin`) | Developer only, through `/owner` | | | | | |

## 5. How enforcement works (and stays correct)

1. **Route declaration.** Every route is registered with exactly one access value: `public`,
   `user`, `super`, or a permission. *Built.* A test fails if any organization route is missing one.
2. **Membership check before data.** The Worker reads the caller's membership row from D1 (role,
   `deactivated_at`, `location_ids`), checks the organization is live, then checks
   `can(role, permission)`. Only then is the organization's Durable Object called. *Built,
   extended by F3 and F9.*
3. **Caller context into the Durable Object.** The Durable Object receives `{ userId, role,
   permissions, locationIds, approvalRules }` and applies the rules that need its data (location
   checks on a movement, approval thresholds on an adjustment). The Worker computed it; the object
   trusts it because only the Worker can call it.
4. **Response shaping.** Fields a role may not see (cost, customer contact details) are removed in one
   function per entity (`shapeProduct`, `shapeOrder`) before responses leave the Worker. It is used by
   every route that returns that entity, including lists, CSV export and the dashboard.
5. **Tests from the matrix.** A test reads `ROLE_PERMISSIONS` and, for every role and every
   organization route, sends a request and expects 2xx or 403 to match. Adding a route without
   updating the matrix fails the build.

## 6. Activity log entries

Every new action in this plan writes one entry with: actor (user id, or `support:<developer>`,
or `key:<prefix>`, or `system`), action, entity, entity id, field-level changes, request id, time.
Approvals record both the requester and the approver. Support access records every request made in
the window, including reads.
