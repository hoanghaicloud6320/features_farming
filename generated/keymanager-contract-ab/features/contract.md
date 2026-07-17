# Farmed features: Key Manager Cloud Admin API

An administrative API for managing licenses, sessions, and audit logs within the Key Manager Cloud service.

## Authentication

unknown
- Uncertain: No explicit authentication headers or tokens were identified in the captured traffic.

## Endpoints

### GET /v1/admin/:var

- Purpose: Retrieve administrative resources such as sessions, licenses, or audit logs.
- Request: Query parameter: limit (optional)
- Response: JSON object containing resource data or lists (e.g., audit_logs array).
- Observed statuses: 200
- Confidence: observed
- Evidence: GET /v1/admin/session
- Evidence: GET /v1/admin/licenses?limit=100
- Evidence: GET /v1/admin/audit-logs
- Warning: Concrete sibling names are recoverable from examples, but request fields, response schemas, query keys, and statuses are aggregated at the generalized endpoint level and may differ by sibling.

### POST /v1/admin/:var

- Purpose: Perform administrative actions such as login, logout, or license creation.
- Request: JSON body containing fields like key, registrant_name, product, or expires_at.
- Response: JSON object containing operation results or created license details.
- Observed statuses: 200, 201
- Confidence: observed
- Evidence: POST /v1/admin/login
- Evidence: POST /v1/admin/licenses
- Evidence: POST /v1/admin/logout
- Warning: Concrete sibling names are recoverable from examples, but request fields, response schemas, query keys, and statuses are aggregated at the generalized endpoint level and may differ by sibling.

### PATCH /v1/admin/licenses/:uuid

- Purpose: Update details of an existing license.
- Request: JSON body containing fields like license_key, product, or expires_at.
- Response: JSON object containing the updated license details.
- Observed statuses: 200
- Confidence: observed
- Evidence: PATCH /v1/admin/licenses/7bade622-b72c-4182-9e5a-6affba227268

### DELETE /v1/admin/licenses/:uuid

- Purpose: Remove an existing license.
- Request: None
- Response: Empty or confirmation object.
- Observed statuses: 200, 204
- Confidence: observed
- Evidence: DELETE /v1/admin/licenses/7bade622-b72c-4182-9e5a-6affba227268

## Workflows

### License Lifecycle Management

1. POST /v1/admin/licenses
2. GET /v1/admin/licenses?limit=100
3. PATCH /v1/admin/licenses/:uuid
4. DELETE /v1/admin/licenses/:uuid
- Data flow: POST response license_key to PATCH request license_key
- Data flow: POST response product to PATCH request product
- Data flow: POST response expires_at to PATCH request expires_at
- Data flow: PATCH URL uuid to PATCH response license.id
- Confidence: observed

## Uncertainties

- Authentication mechanism is unknown.
- Exact response schemas for specific siblings are not fully defined.
- Error handling statuses are not explicitly captured.

## Optional Node.js sample

```js
const fetch = require('node-fetch'); const baseUrl = 'https://keymanager-cloud.thuanvatlyhy.workers.dev/v1/admin'; async function getAuditLogs() { const res = await fetch(`${baseUrl}/audit-logs?limit=50`); return res.json(); }
```
