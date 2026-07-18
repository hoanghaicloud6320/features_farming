'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  farmRecording,
  findBoundedTransformRelations,
  findHashRelations,
  parseStructuredText,
} = require('../src/farm');
const { farmInput } = require('../src/collection');
const { buildFeatureContext, compactFeatureContext } = require('../src/gym-ab');

test('parses JSON and form payloads', () => {
  assert.deepEqual(parseStructuredText('{"id":3}', 'application/json'), {
    format: 'json',
    value: { id: 3 },
  });
  assert.deepEqual(parseStructuredText('q=hello+world&limit=5', 'application/x-www-form-urlencoded'), {
    format: 'form',
    value: { q: 'hello world', limit: '5' },
  });
});

test('finds a repeated multi-source hash transform', () => {
  const occurrences = [];
  const iterations = ['iteration-1', 'iteration-2', 'iteration-3'];
  for (let index = 0; index < iterations.length; index += 1) {
    const iterationId = iterations[index];
    const values = {
      label: `label-${index}`,
      seed: `seed-${index}`,
      salt: `salt-${index}`,
    };
    const add = (id, side, fieldPath, value, requestIndex) => occurrences.push({
      id: `${iterationId}-${id}`,
      iterationId,
      requestId: `${iterationId}-request-${requestIndex}`,
      requestIndex,
      endpointId: side === 'request-target' ? 'bridge' : 'origin',
      endpoint: side === 'request-target' ? 'PUT example.test/bridge?' : 'POST example.test/origin?',
      side: side === 'request-target' ? 'request' : side,
      location: 'body.json',
      fieldPath,
      value,
      canonical: String(value),
      type: 'string',
    });
    add('label', 'request', '$.label', values.label, 0);
    add('seed', 'response', '$.seed', values.seed, 0);
    add('salt', 'response', '$.salt', values.salt, 0);
    const proof = require('node:crypto').createHash('sha256')
      .update(`${values.seed}:${values.salt}:${values.label}`)
      .digest('hex')
      .slice(0, 24);
    add('proof', 'request-target', '$.proof', proof, 1);
  }
  const relation = findHashRelations(occurrences, iterations)[0];
  assert.equal(relation.kind, 'hash-derived-copy');
  assert.equal(relation.transform.algorithm, 'sha256');
  assert.equal(relation.transform.delimiter, ':');
  assert.deepEqual(relation.transform.slice, { start: 0, length: 24 });
  assert.deepEqual(relation.sources.map((source) => source.fieldPath), ['$.seed', '$.salt', '$.label']);
});

test('does not promote a three-point numeric coincidence to an affine data flow', () => {
  const iterations = ['iteration-1', 'iteration-2', 'iteration-3'];
  const occurrences = [];
  iterations.forEach((iterationId, index) => {
    const add = (id, endpointId, endpoint, side, fieldPath, value, requestIndex) => {
      occurrences.push({
        id: `${iterationId}-${id}`,
        iterationId,
        requestId: `${iterationId}-${id}`,
        requestIndex,
        endpointId,
        endpoint,
        side,
        location: 'body.json',
        fieldPath,
        value,
        canonical: String(value),
        type: 'integer',
      });
    };
    add('source', 'open', 'POST example.test/open?', 'response', '$.randomCounter', index + 1, 0);
    add('target', 'close', 'PUT example.test/close?', 'request', '$.otherCounter', (index + 1) * 3 + 17, 1);
  });
  const relations = findBoundedTransformRelations(occurrences, iterations);
  assert.equal(relations.some((relation) => relation.kind === 'affine-numeric'), false);
});

test('farms variables, request-response echo and route templates', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'features-farming-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = path.join(root, 'recording');
  const output = path.join(root, 'features');
  fs.mkdirSync(path.join(input, 'bodies'), { recursive: true });
  fs.writeFileSync(path.join(input, 'manifest.json'), JSON.stringify({
    id: 'test-recording',
    startUrl: 'https://example.test/',
  }));
  fs.writeFileSync(path.join(input, 'iterations.json'), JSON.stringify([
    { id: 'iteration-1', requestCount: 1 },
    { id: 'iteration-2', requestCount: 1 },
    { id: 'iteration-3', requestCount: 1 },
  ]));

  const requests = [1, 2, 3].map((id, index) => ({
    id: `request-${id}`,
    requestId: `request-${id}`,
    iterationId: `iteration-${id}`,
    requestTimestamp: index * 10,
    responseTimestamp: index * 10 + 1,
    resourceType: 'Fetch',
    request: {
      method: 'POST',
      url: `https://example.test/users/${id}?limit=5`,
      headers: { 'content-type': 'application/json' },
      postData: JSON.stringify({ userId: id, label: `iteration-${id}` }),
    },
    response: { status: 200, mimeType: 'application/json' },
    durationMs: 10 + index,
    body: { file: `bodies/${id}.json` },
  }));
  fs.writeFileSync(path.join(input, 'requests.json'), JSON.stringify(requests));
  for (const id of [1, 2, 3]) {
    fs.writeFileSync(path.join(input, 'bodies', `${id}.json`), JSON.stringify({
      userId: id,
      label: `iteration-${id}`,
      serverId: 101,
    }));
  }

  const result = await farmRecording({ inputDirectory: input, outputDirectory: output });
  assert.equal(result.endpoints.length, 1);
  assert.match(result.endpoints[0].pathnameTemplate, /:number/);
  assert.ok(result.summary.variables.some((field) => field.fieldPath === '$.userId' && field.classification === 'increasing'));
  assert.ok(result.summary.relations.some((relation) => (
    relation.source.fieldPath === '$.label'
    && relation.target.fieldPath === '$.label'
    && relation.supportIterations === 3
  )));
  assert.ok(fs.existsSync(path.join(output, 'report.md')));
  assert.ok(fs.existsSync(path.join(output, 'occurrences.jsonl')));
});

function writeAdvancedRecording(input, recordingId, tokenPrefix) {
  fs.mkdirSync(path.join(input, 'bodies'), { recursive: true });
  fs.writeFileSync(path.join(input, 'manifest.json'), JSON.stringify({
    id: recordingId,
    startUrl: 'https://example.test/',
  }));
  fs.writeFileSync(path.join(input, 'iterations.json'), JSON.stringify([
    { id: 'iteration-1', requestCount: 5 },
    { id: 'iteration-2', requestCount: 5 },
    { id: 'iteration-3', requestCount: 5 },
  ]));
  fs.writeFileSync(path.join(input, 'cookies.json'), JSON.stringify([
    { name: 'sid', value: `${tokenPrefix}-3`, domain: 'example.test', path: '/', secure: true, httpOnly: true },
  ]));
  const requests = [];
  for (let iteration = 1; iteration <= 3; iteration += 1) {
    const iterationId = `iteration-${iteration}`;
    const token = `${tokenPrefix}-${iteration}`;
    const baseTime = iteration * 100;
    const loginId = `${recordingId}-login-${iteration}`;
    requests.push({
      id: loginId,
      requestId: loginId,
      iterationId,
      requestTimestamp: baseTime,
      responseTimestamp: baseTime + 0.1,
      resourceType: 'Fetch',
      request: {
        method: 'POST',
        url: 'https://example.test/login',
        headers: { 'content-type': 'application/json' },
        postData: JSON.stringify({ username: `user-${iteration}` }),
      },
      response: { status: 200, mimeType: 'application/json' },
      responseExtraInfo: { headers: { 'set-cookie': `sid=${token}; Path=/; HttpOnly; Secure` } },
      body: { file: `bodies/login-${iteration}.json` },
    });
    fs.writeFileSync(path.join(input, 'bodies', `login-${iteration}.json`), JSON.stringify({
      token,
      items: [
        { id: iteration * 10 + 1, name: 'alpha' },
        { id: iteration * 10 + 2, name: 'bravo' },
      ],
    }));
    const apiId = `${recordingId}-api-${iteration}`;
    requests.push({
      id: apiId,
      requestId: apiId,
      iterationId,
      requestTimestamp: baseTime + 0.5,
      responseTimestamp: baseTime + 0.6,
      resourceType: 'Fetch',
      request: {
        method: 'GET',
        url: 'https://example.test/account',
        headers: { authorization: `Bearer ${token}` },
      },
      requestExtraInfo: {
        headers: { authorization: `Bearer ${token}` },
        associatedCookies: [{
          cookie: { name: 'sid', value: token, domain: 'example.test', path: '/', secure: true, httpOnly: true },
          blockedReasons: [],
        }],
      },
      response: { status: 302, mimeType: 'text/html' },
      redirectResponse: {
        url: 'https://example.test/account',
        status: 302,
        headers: { location: 'https://example.test/dashboard' },
      },
    });
    const dashboardId = `${recordingId}-dashboard-${iteration}`;
    requests.push({
      id: dashboardId,
      requestId: dashboardId,
      iterationId,
      requestTimestamp: baseTime + 0.7,
      responseTimestamp: baseTime + 0.8,
      resourceType: 'Document',
      request: { method: 'GET', url: 'https://example.test/dashboard', headers: {} },
      response: { status: 200, mimeType: 'text/html' },
      initiator: { type: 'parser', url: 'https://example.test/account', lineNumber: 1 },
    });
    for (let poll = 0; poll < 3; poll += 1) {
      const pollId = `${recordingId}-poll-${iteration}-${poll}`;
      requests.push({
        id: pollId,
        requestId: pollId,
        iterationId,
        requestTimestamp: baseTime + 1 + poll,
        responseTimestamp: baseTime + 1.1 + poll,
        resourceType: 'Fetch',
        request: { method: 'GET', url: 'https://example.test/jobs/status?id=42', headers: {} },
        response: { status: 200, mimeType: 'application/json' },
      });
    }
  }
  fs.writeFileSync(path.join(input, 'requests.json'), JSON.stringify(requests));
}

test('extracts generalized arrays, token/cookie lineage, redirects and polling', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'features-advanced-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = path.join(root, 'recording');
  const output = path.join(root, 'features');
  writeAdvancedRecording(input, 'advanced', 'token');
  const result = await farmRecording({ inputDirectory: input, outputDirectory: output });

  assert.ok(result.schemas.some((schema) => schema.kind === 'array' && schema.fieldPath === '$.items'));
  assert.ok(result.schemas.some((schema) => schema.fieldPath === '$.items[].id'));
  assert.ok(result.relations.some((relation) => relation.kind === 'authorization-token-copy'));
  assert.ok(result.relations.some((relation) => (
    relation.source.location === 'cookie' || relation.target.location === 'cookie'
  )));
  assert.ok(result.dependencyGraph.edges.some((edge) => edge.type === 'redirect'));
  assert.ok(result.dependencyGraph.edges.some((edge) => edge.type === 'initiator-request'));
  assert.equal(result.workflowPatterns.polling.length, 3);
  assert.ok(result.cookieInventory.some((cookie) => cookie.name === 'sid' && cookie.iterationPresence === 3));
  const occurrenceText = fs.readFileSync(path.join(output, 'occurrences.jsonl'), 'utf8');
  assert.doesNotMatch(occurrenceText, /Bearer token-/);
  assert.match(occurrenceText, /"preview":"\[REDACTED\]"/);
});

test('describes the forward transform for a base64url Bearer token', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'features-bearer-base64-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = path.join(root, 'recording');
  const output = path.join(root, 'features');
  writeAdvancedRecording(input, 'base64', 'capsule');
  const requestFile = path.join(input, 'requests.json');
  const requests = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
  for (const request of requests) {
    const authorization = request.requestExtraInfo?.headers?.authorization;
    if (!authorization) continue;
    const token = authorization.replace(/^Bearer\s+/, '');
    const encoded = Buffer.from(token, 'utf8').toString('base64url');
    request.request.headers.authorization = `Bearer ${encoded}`;
    request.requestExtraInfo.headers.authorization = `Bearer ${encoded}`;
  }
  fs.writeFileSync(requestFile, JSON.stringify(requests));

  const result = await farmRecording({ inputDirectory: input, outputDirectory: output });
  const relation = result.relations.find((item) => item.kind === 'authorization-base64-decoded-copy');
  assert.ok(relation);
  assert.deepEqual(relation.transform, {
    direction: 'source-to-target',
    steps: [
      { operation: 'base64url-encode-utf8', padding: false },
      { operation: 'prefix', value: 'Bearer ' },
    ],
  });
});

test('aggregates repeated evidence across recording sessions', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'features-collection-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = path.join(root, 'scenario');
  writeAdvancedRecording(path.join(input, 'run-a'), 'run-a', 'session-a');
  writeAdvancedRecording(path.join(input, 'run-b'), 'run-b', 'session-b');
  const output = path.join(root, 'features');
  const farmed = await farmInput({ inputDirectory: input, outputDirectory: output });

  assert.equal(farmed.mode, 'collection');
  assert.equal(farmed.summary.sessionCount, 2);
  assert.ok(farmed.summary.crossSessionEndpoints.some((endpoint) => endpoint.sessionPresence === 2));
  assert.ok(farmed.summary.crossSessionSchemas.some((schema) => schema.fieldPath === '$.items'));
  assert.ok(farmed.summary.crossSessionRelations.some((relation) => relation.kind === 'authorization-token-copy'));
  assert.ok(fs.existsSync(path.join(output, 'report.md')));
});

function writeSiblingRecording(input, recordingId) {
  fs.mkdirSync(path.join(input, 'bodies'), { recursive: true });
  fs.writeFileSync(path.join(input, 'manifest.json'), JSON.stringify({
    id: recordingId,
    startUrl: 'https://example.test/admin',
  }));
  fs.writeFileSync(path.join(input, 'iterations.json'), JSON.stringify([1, 2, 3].map((iteration) => ({
    id: `iteration-${iteration}`,
    requestCount: 3,
  }))));
  const definitions = [
    {
      path: 'login',
      status: 201,
      request: (iteration) => ({ username: `user-${iteration}`, password: `secret-${iteration}` }),
      response: (iteration) => ({ session: { token: `token-${recordingId}-${iteration}`, expiresAt: 1000 + iteration } }),
    },
    {
      path: 'licenses',
      status: 202,
      request: (iteration) => ({
        licenseKey: `key-${iteration}`,
        limits: { seats: iteration + 1 },
        sessionToken: `token-${recordingId}-${iteration}`,
      }),
      response: (iteration) => ({ jobId: `job-${recordingId}-${iteration}`, queued: true }),
    },
    {
      path: 'logout',
      status: 204,
      request: (iteration) => ({ allDevices: iteration % 2 === 0 }),
      response: null,
    },
  ];
  const requests = [];
  for (let iteration = 1; iteration <= 3; iteration += 1) {
    definitions.forEach((definition, position) => {
      const id = `${recordingId}-${definition.path}-${iteration}`;
      const bodyFile = definition.response ? `bodies/${definition.path}-${iteration}.json` : null;
      requests.push({
        id,
        requestId: id,
        iterationId: `iteration-${iteration}`,
        requestTimestamp: iteration * 100 + position,
        responseTimestamp: iteration * 100 + position + 0.5,
        resourceType: 'Fetch',
        request: {
          method: 'POST',
          url: `https://example.test/v1/admin/${definition.path}`,
          headers: { 'content-type': 'application/json' },
          postData: JSON.stringify(definition.request(iteration)),
        },
        response: { status: definition.status, mimeType: definition.response ? 'application/json' : 'text/plain' },
        body: bodyFile ? { file: bodyFile } : undefined,
      });
      if (bodyFile) {
        fs.writeFileSync(path.join(input, bodyFile), JSON.stringify(definition.response(iteration)));
      }
    });
  }
  fs.writeFileSync(path.join(input, 'requests.json'), JSON.stringify(requests));
}

test('preserves lossless per-sibling statuses and incompatible schemas across sessions', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'features-siblings-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = path.join(root, 'scenario');
  writeSiblingRecording(path.join(input, 'run-a'), 'run-a');
  writeSiblingRecording(path.join(input, 'run-b'), 'run-b');
  const output = path.join(root, 'features');
  const farmed = await farmInput({ inputDirectory: input, outputDirectory: output });

  const family = farmed.summary.crossSessionEndpoints.find((endpoint) => (
    endpoint.signature.includes('POST example.test/v1/admin/:var')
  ));
  assert.ok(family);
  assert.equal(family.members.length, 3);

  const login = family.members.find((member) => member.pathnameTemplate.endsWith('/login'));
  const licenses = family.members.find((member) => member.pathnameTemplate.endsWith('/licenses'));
  const logout = family.members.find((member) => member.pathnameTemplate.endsWith('/logout'));
  assert.deepEqual(login.statusCounts, { 201: 6 });
  assert.deepEqual(licenses.statusCounts, { 202: 6 });
  assert.deepEqual(logout.statusCounts, { 204: 6 });
  assert.equal(login.sessionPresence, 2);
  assert.equal(login.iterationPresence, 6);
  assert.equal(login.totalRequestCount, 6);

  assert.ok(login.requestFields.some((field) => field.fieldPath === '$.username'));
  assert.ok(!login.requestFields.some((field) => field.fieldPath === '$.licenseKey'));
  assert.ok(licenses.requestFields.some((field) => field.fieldPath === '$.limits.seats'));
  assert.ok(logout.requestFields.some((field) => field.fieldPath === '$.allDevices'));
  assert.ok(login.responseSchemas.some((schema) => schema.fieldPath === '$.session.token'));
  assert.ok(licenses.responseSchemas.some((schema) => schema.fieldPath === '$.jobId'));
  assert.equal(logout.responseSchemas.length, 0);
  assert.ok(farmed.summary.crossSessionMemberRelations.some((relation) => (
    relation.source.routeKey.endsWith('/login')
    && relation.source.fieldPath === '$.session.token'
    && relation.target.routeKey.endsWith('/licenses')
    && relation.target.fieldPath === '$.sessionToken'
  )));

  const context = buildFeatureContext(output);
  const contractLogin = context.contractInventory.find((endpoint) => endpoint.path.endsWith('/login'));
  const contractLicenses = context.contractInventory.find((endpoint) => (
    endpoint.method === 'POST' && endpoint.path.endsWith('/licenses')
  ));
  assert.deepEqual(contractLogin.observed.statusCounts, { 201: 6 });
  assert.ok(contractLogin.responseSchemas.some((schema) => schema.path === 'body.json$.session.token'));
  assert.ok(contractLicenses.requestFields.some((field) => field.path === 'body.json$.sessionToken'));
  assert.ok(contractLicenses.dataFlows.selected.some((relation) => (
    relation.from.endpoint === 'POST /v1/admin/login'
    && relation.from.field === 'response.body.json$.session.token'
    && relation.to.endpoint === 'POST /v1/admin/licenses'
    && relation.to.field === 'request.body.json$.sessionToken'
  )));
  const compact = compactFeatureContext(context, 12_000);
  assert.ok(JSON.stringify(compact).length <= 12_000);
  assert.equal(compact.contractInventory.length, 3);
  assert.ok(compact.contractInventory.some((endpoint) => (
    endpoint.method === 'POST'
    && endpoint.path.endsWith('/licenses')
    && endpoint.dataFlows.selected.some((relation) => relation.to.field.endsWith('$.sessionToken'))
  )));
  assert.ok(fs.existsSync(path.join(output, 'endpoints.cross-session.json')));
});
