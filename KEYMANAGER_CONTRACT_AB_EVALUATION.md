# KeyManager dashboard API-contract A/B

## Experiment

Target:

```text
https://keymanager-cloud.thuanvatlyhy.workers.dev/admin
```

The recorder ran three independent browser sessions with three iterations per
session. Every iteration performed:

1. admin login;
2. license list refresh;
3. license creation with changing values;
4. license update and revoke;
5. audit-log retrieval;
6. license deletion;
7. logout.

All created records were temporary and deleted during the same iteration. The
recording contains 159 HTTP requests across nine complete iterations.

Before evidence was sent to Gemini, authorization, cookie, token, secret,
password, license-key, and session-key values were replaced with stable short
hashes. The four arms used the same prompt, response schema, model, seed, and
32,000-character evidence budget.

Model: `gemini-3.1-flash-lite`.

## Results

| Evidence | Evidence chars | Prompt tokens | Endpoint claims | Workflow claims |
|---|---:|---:|---:|---:|
| None | 94 | 217 | 0 | 0 |
| Raw | 31,760 | 17,955 | 8 | 1 |
| Farmed features | 31,667 | 13,318 | 4 | 1 |
| Raw + features | 31,516 | 14,818 | 4 | 1 |

### No evidence

Gemini correctly declined to invent a contract.

### Raw

Raw produced the most specific endpoint inventory:

```text
POST   /v1/admin/login
POST   /v1/admin/logout
GET    /v1/admin/session
GET    /v1/admin/licenses
POST   /v1/admin/licenses
PATCH  /v1/admin/licenses/{id}
DELETE /v1/admin/licenses/{id}
GET    /v1/admin/audit-logs
```

It also recovered the create-response ID dependency used by PATCH and DELETE,
the observed 201/204 statuses, and the full license lifecycle.

It correctly described authentication as session-based while leaving the exact
cookie/header persistence mechanism uncertain.

### Farmed features

Features recovered all operation families, PATCH/DELETE UUID templating, core
workflow, and repeated request/response relations using about 25% fewer prompt
tokens than raw.

However, route templating generalized same-shaped sibling routes:

```text
GET  /v1/admin/:var
POST /v1/admin/:var
```

This merges:

- `session`, `licenses`, and `audit-logs` for GET;
- `login`, `logout`, and `licenses` for POST.

The output is useful as a behavioral overview but is not sufficiently precise
as a standalone API contract.

### Raw + features

The combined arm correctly described session-based authentication and retained
create, list, update, delete, audit, and logout behavior. It also used fewer
tokens than raw.

It still emitted the generalized GET/POST `:var` endpoints because the feature
summary strongly framed the route structure. Concrete raw examples were used
as evidence but were not promoted into separate endpoint definitions.

## Features-only unroll diagnostic

A fifth diagnostic reused the exact `features-only` evidence but changed the
instruction to explicitly expand `:var` whenever concrete sibling examples
were present. This is not part of the canonical four-arm matrix because the
prompt differs.

| Output | Prompt tokens | Endpoint definitions |
|---|---:|---:|
| Features, neutral prompt | 13,318 | 4 generalized |
| Features, unroll prompt | 13,398 | 8 concrete |
| Raw, neutral prompt | 17,955 | 8 concrete |

The unrolled feature output recovered the complete observed inventory:

```text
GET    /v1/admin/session
GET    /v1/admin/licenses
GET    /v1/admin/audit-logs
POST   /v1/admin/login
POST   /v1/admin/licenses
POST   /v1/admin/logout
PATCH  /v1/admin/licenses/:uuid
DELETE /v1/admin/licenses/:uuid
```

This confirms that generalization itself was not information loss at the
endpoint-name level: concrete examples remained available and Gemini could
expand them when the requested output called for it.

The feature context now emits a structured warning for every semantic `:var`
family. The unroll prompt uses that warning to leave sibling-specific statuses
empty and mark request/response details inferred unless evidence is associated
with the concrete sibling. This avoids transferring aggregate attributes to
the wrong endpoint.

The current features are therefore sufficient for the concrete endpoint names,
but not for exact per-sibling status and schema attribution.

## Verdict

It is too strong to say that raw “wins” without naming the target metric:

- **Concrete endpoint coverage:** prompted features-only and raw both recover
  8/8; features use substantially fewer tokens.
- **Observed status and response fidelity:** raw is stronger.
- **Token efficiency and behavioral abstraction:** features are stronger.
- **Neutral-prompt API contract:** raw is more directly usable.

Farmer is useful for:

- cross-iteration workflow ordering;
- UUID path templating;
- repeated data-flow discovery;
- compression and removal of low-value observations.

Farmer currently hurts contract specificity when stable sibling action names
share method, host, resource type, and path shape. The correct product design
is therefore not “replace raw with features,” but:

```text
raw endpoint inventory
  + farmer relations/workflow
  + a route-generalization rule that preserves semantic siblings
```

This real dashboard result demonstrates that farmer value is real but
task-dependent. It adds analysis and a reversible abstraction for route names,
but some sibling-specific attributes are not fully reversible after
aggregation.

## Harness corrections

The first diagnostic run exposed two harness bugs and was discarded:

1. the raw projector accepted only `/api/` paths while this application uses
   `/v1/`;
2. feature compaction could exceed its budget when relation count was large.

The final run uses configurable raw path prefixes, strict envelope-inclusive
budgets, and endpoint-preserving feature compaction. A regression test covers
the high-relation-count budget case.

## Artifacts

- `generated/keymanager-contract-ab/none/contract.md`
- `generated/keymanager-contract-ab/raw/contract.md`
- `generated/keymanager-contract-ab/features/contract.md`
- `generated/keymanager-contract-ab/raw-features/contract.md`
- `generated/keymanager-contract-ab/features-unrolled/contract.md`
- `generated/keymanager-contract-ab/matrix.json`

## 2026-07-18 per-sibling provenance rerun

The farmer now keeps a concrete member index beneath every generalized
`:var` family. Each member carries its own request/session/iteration support,
status counts, query keys, request fields, response schemas, examples, and
relations. The generalized family remains the primary route abstraction.

The same three-session, nine-iteration, 159-request recording was reused.
Results were written separately under
`generated/keymanager-contract-ab-after-provenance`.

| Output | Before | After |
|---|---:|---:|
| Neutral features endpoint claims | 4 generalized | 8 concrete |
| Explicit-unroll endpoint claims | 8 concrete | 8 concrete |
| Explicit-unroll endpoints with exact observed statuses | 0/8 | 8/8 |
| Neutral features prompt tokens | 13,318 | 15,504 |
| Explicit-unroll prompt tokens | 13,398 | 15,586 |
| Raw reference prompt tokens after rerun | - | 17,967 |

The after-run feature contract attributed these status sets:

```text
GET    /v1/admin/audit-logs       200
GET    /v1/admin/licenses         200
GET    /v1/admin/session          401
POST   /v1/admin/licenses         201
POST   /v1/admin/login            200
POST   /v1/admin/logout           200
PATCH  /v1/admin/licenses/:uuid   200
DELETE /v1/admin/licenses/:uuid   204
```

These match the raw reference. Features-only therefore moved from reversible
endpoint-name discovery with ambiguous sibling attributes to a directly usable
concrete contract with member-attributed statuses and schemas. The additional
provenance increased the neutral feature prompt by 16.4%, while remaining
13.7% below the rerun raw prompt.

The raw+features arm emitted six concrete endpoints in this rerun. This is
better than the previous four generalized claims but below the eight endpoints
from features-only and raw. Since the feature-only arm contains all eight
within the same evidence budget, this combined-arm miss is a generation/ranking
result rather than loss of member provenance and remains an evaluation target.
