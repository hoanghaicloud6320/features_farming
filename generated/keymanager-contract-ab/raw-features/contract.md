# Raw + features: KeyManager Admin API

An administrative API for managing software licenses, audit logs, and session authentication.

## Authentication

Session-based (Cookie/Token)
- GET /v1/admin/session returns 401 UNAUTHORIZED
- POST /v1/admin/login establishes session
- POST /v1/admin/logout terminates session
- Uncertain: Exact header or cookie name used for session persistence is not explicitly defined in the provided evidence.

## Endpoints

### GET /v1/admin/:var

- Purpose: Retrieve administrative data (session, licenses, or audit logs)
- Request: Query parameter: limit (optional)
- Response: JSON object containing requested resource (e.g., licenses array, audit_logs array, or admin info)
- Observed statuses: 200, 401
- Confidence: observed
- Evidence: GET /v1/admin/session
- Evidence: GET /v1/admin/licenses?limit=100
- Evidence: GET /v1/admin/audit-logs
- Warning: Concrete sibling names are recoverable from examples, but request fields, response schemas, query keys, and statuses are aggregated at the generalized endpoint level and may differ by sibling.

### POST /v1/admin/:var

- Purpose: Perform administrative actions (login, logout, create license)
- Request: JSON body (varies by action, e.g., {name} for login, {key, registrant_name, product, etc.} for licenses)
- Response: JSON object confirming action (e.g., {admin}, {ok}, or {license, key})
- Observed statuses: 200, 201
- Confidence: observed
- Evidence: POST /v1/admin/login
- Evidence: POST /v1/admin/logout
- Evidence: POST /v1/admin/licenses
- Warning: Concrete sibling names are recoverable from examples, but request fields, response schemas, query keys, and statuses are aggregated at the generalized endpoint level and may differ by sibling.

### PATCH /v1/admin/licenses/:uuid

- Purpose: Update an existing license
- Request: JSON body containing fields to update (e.g., license_key, product, expires_at, registrant_name)
- Response: JSON object containing updated license details
- Observed statuses: 200
- Confidence: observed
- Evidence: PATCH /v1/admin/licenses/:uuid

### DELETE /v1/admin/licenses/:uuid

- Purpose: Delete an existing license
- Request: Empty body
- Response: Empty body
- Observed statuses: 204
- Confidence: observed
- Evidence: DELETE /v1/admin/licenses/:uuid

## Workflows

### License Lifecycle Management

1. POST /v1/admin/login
2. GET /v1/admin/licenses
3. PATCH /v1/admin/licenses/:uuid
4. DELETE /v1/admin/licenses/:uuid
- Data flow: POST /v1/admin/licenses returns license ID used in subsequent PATCH/DELETE
- Data flow: PATCH /v1/admin/licenses/:uuid returns updated license object
- Confidence: observed

## Uncertainties

- The exact structure of the audit-logs response is partially truncated in the evidence.
- The specific authentication header name is not explicitly captured.
- The PATCH endpoint response schema is inferred from the relation mapping rather than a full raw capture.

## Optional Node.js sample

```js
const res = await fetch('https://keymanager-cloud.thuanvatlyhy.workers.dev/v1/admin/licenses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'KM-123', registrant_name: 'User', product: 'App' }) }); const data = await res.json();
```
