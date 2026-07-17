# Farmed features · explicit unroll: KeyManager Cloud Admin API

An administrative API for managing licenses, sessions, and audit logs on the KeyManager Cloud platform.

## Authentication

unknown
- Uncertain: No explicit authentication headers or tokens were identified in the captured traffic.

## Endpoints

### GET /v1/admin/session

- Purpose: Retrieve session information
- Request: Empty body
- Response: JSON object
- Observed statuses: none
- Confidence: inferred
- Evidence: Example observed in traffic
- Warning: Sibling-specific request fields, response schemas, query keys, and statuses may differ unless evidence explicitly associates them with this concrete sibling.

### GET /v1/admin/licenses

- Purpose: Retrieve license list
- Request: Query param: limit
- Response: JSON object
- Observed statuses: none
- Confidence: inferred
- Evidence: Example observed in traffic
- Warning: Sibling-specific request fields, response schemas, query keys, and statuses may differ unless evidence explicitly associates them with this concrete sibling.

### GET /v1/admin/audit-logs

- Purpose: Retrieve audit logs
- Request: Empty body
- Response: JSON object containing audit_logs array
- Observed statuses: none
- Confidence: inferred
- Evidence: Example observed in traffic
- Warning: Sibling-specific request fields, response schemas, query keys, and statuses may differ unless evidence explicitly associates them with this concrete sibling.

### POST /v1/admin/login

- Purpose: User authentication
- Request: JSON body
- Response: JSON object
- Observed statuses: none
- Confidence: inferred
- Evidence: Example observed in traffic
- Warning: Sibling-specific request fields, response schemas, query keys, and statuses may differ unless evidence explicitly associates them with this concrete sibling.

### POST /v1/admin/licenses

- Purpose: Create a new license
- Request: JSON body containing key, registrant_name, product, expires_at
- Response: JSON object containing license details
- Observed statuses: none
- Confidence: inferred
- Evidence: Example observed in traffic
- Evidence: Relation: request.body.json$.key -> response.body.json$.license.license_key
- Warning: Sibling-specific request fields, response schemas, query keys, and statuses may differ unless evidence explicitly associates them with this concrete sibling.

### POST /v1/admin/logout

- Purpose: User logout
- Request: Empty body
- Response: JSON object
- Observed statuses: none
- Confidence: inferred
- Evidence: Example observed in traffic
- Warning: Sibling-specific request fields, response schemas, query keys, and statuses may differ unless evidence explicitly associates them with this concrete sibling.

### PATCH /v1/admin/licenses/:uuid

- Purpose: Update an existing license
- Request: JSON body containing license_key, product, expires_at, registrant_name
- Response: JSON object containing updated license details
- Observed statuses: none
- Confidence: observed
- Evidence: Relation: request.body.json$.license_key -> response.body.json$.license.license_key

### DELETE /v1/admin/licenses/:uuid

- Purpose: Delete a license
- Request: Empty body
- Response: Empty or status object
- Observed statuses: none
- Confidence: observed
- Evidence: Endpoint observed in traffic

## Workflows

### License Lifecycle Management

1. POST /v1/admin/licenses
2. GET /v1/admin/audit-logs
3. PATCH /v1/admin/licenses/:uuid
4. DELETE /v1/admin/licenses/:uuid
- Data flow: License creation propagates key and registrant data to response
- Data flow: Audit logs track entity changes
- Data flow: License updates reflect in subsequent GET requests
- Confidence: observed

## Uncertainties

- Authentication mechanism is unknown.
- HTTP status codes were not explicitly captured.
- Request/response schemas are inferred from relations and examples rather than formal definitions.

## Optional Node.js sample

```js
fetch('https://keymanager-cloud.thuanvatlyhy.workers.dev/v1/admin/licenses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'example-key', product: 'pro', registrant_name: 'user' }) }).then(res => res.json()).then(console.log);
```
