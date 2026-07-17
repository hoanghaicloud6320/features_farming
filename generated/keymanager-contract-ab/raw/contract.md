# Raw recorder: KeyManager Cloud Admin API

An administrative API for managing software licenses, including creation, updates, deletion, and audit logging.

## Authentication

Session-based authentication
- GET /v1/admin/session returns 401 Unauthorized when not logged in
- POST /v1/admin/login establishes session
- POST /v1/admin/logout terminates session
- Uncertain: Exact cookie or header token structure is not visible in the provided traffic

## Endpoints

### GET /v1/admin/session

- Purpose: Check current admin session status
- Request: Empty body
- Response: JSON object with error code and message
- Observed statuses: 401
- Confidence: observed
- Evidence: GET /v1/admin/session returns 401 when unauthenticated

### POST /v1/admin/login

- Purpose: Authenticate admin user
- Request: JSON object with name field
- Response: JSON object containing admin profile
- Observed statuses: 200
- Confidence: observed
- Evidence: POST /v1/admin/login with name field

### POST /v1/admin/logout

- Purpose: Terminate admin session
- Request: Empty body
- Response: JSON object with ok: true
- Observed statuses: 200
- Confidence: observed
- Evidence: POST /v1/admin/logout

### GET /v1/admin/licenses

- Purpose: List all licenses
- Request: Query parameter limit=100
- Response: JSON object with licenses array, limit, and offset
- Observed statuses: 200
- Confidence: observed
- Evidence: GET /v1/admin/licenses?limit=100
- Warning: Sibling-specific query keys and response schemas may differ.

### POST /v1/admin/licenses

- Purpose: Create a new license
- Request: JSON object with key, registrant_name, product, dates, limits, and metadata
- Response: JSON object with created license details and key
- Observed statuses: 201
- Confidence: observed
- Evidence: POST /v1/admin/licenses

### PATCH /v1/admin/licenses/:id

- Purpose: Update an existing license
- Request: JSON object with license fields to update
- Response: JSON object with updated license details
- Observed statuses: 200
- Confidence: observed
- Evidence: PATCH /v1/admin/licenses/7bade622-b72c-4182-9e5a-6affba227268
- Warning: Sibling-specific request fields and response schemas may differ.

### DELETE /v1/admin/licenses/:id

- Purpose: Delete a license
- Request: Empty body
- Response: Empty body
- Observed statuses: 204
- Confidence: observed
- Evidence: DELETE /v1/admin/licenses/7bade622-b72c-4182-9e5a-6affba227268
- Warning: Sibling-specific statuses may differ.

### GET /v1/admin/audit-logs

- Purpose: Retrieve audit logs
- Request: Empty body
- Response: JSON object with truncated flag and audit_logs array
- Observed statuses: 200
- Confidence: observed
- Evidence: GET /v1/admin/audit-logs

## Workflows

### License Lifecycle Management

1. Login
2. Create License
3. Update License
4. Delete License
5. Verify Audit Logs
- Data flow: POST /v1/admin/login
- Data flow: POST /v1/admin/licenses
- Data flow: PATCH /v1/admin/licenses/:id
- Data flow: DELETE /v1/admin/licenses/:id
- Data flow: GET /v1/admin/audit-logs
- Confidence: observed

## Uncertainties

- The exact structure of the session token or cookie is not explicitly defined in the traffic.
- The audit log response is truncated, so the full schema of the log entries is inferred from the preview.

## Optional Node.js sample

```js
const response = await fetch('https://keymanager-cloud.thuanvatlyhy.workers.dev/v1/admin/licenses', { method: 'GET', headers: { 'Content-Type': 'application/json' } }); const data = await response.json(); console.log(data);
```
