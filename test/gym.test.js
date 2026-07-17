'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { createGymServer } = require('../gym/server');
const { V5_CASES, applyTransform } = require('../gym/v5-cases');

async function post(origin, route, body, options = {}) {
  const response = await fetch(`${origin}${route}`, {
    method: options.method || 'POST',
    headers: { 'content-type': 'application/json', ...options.headers },
    body: JSON.stringify(body),
  });
  return { response, value: await response.json() };
}

test('all hidden gym workflows accept the intended automation', async (t) => {
  const gym = createGymServer();
  const origin = await gym.listen();
  t.after(() => gym.close());

  const easyStart = await post(origin, '/api/marble/session', { label: 'test' });
  const easyEnd = await post(origin, '/api/marble/confirm', {
    runId: easyStart.value.runId,
    handoffKey: easyStart.value.handoffKey,
  }, { method: 'PUT' });
  assert.equal(easyEnd.value.accepted, true);

  const mediumStart = await post(origin, '/api/lattice/seed', { label: 'test' });
  const mediumEnd = await post(origin, '/api/lattice/unseal', {
    runId: mediumStart.value.runId,
  }, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${Buffer.from(mediumStart.value.capsule).toString('base64url')}`,
    },
  });
  assert.equal(mediumEnd.value.accepted, true);

  const label = 'test-hard';
  const hardStart = await post(origin, '/api/prism/origin', { label, sequence: 7 });
  const proof = crypto.createHash('sha256')
    .update(`${hardStart.value.seed}:${hardStart.value.salt}:${label}`)
    .digest('hex')
    .slice(0, 24);
  const bridge = await post(origin, '/api/prism/bridge', {
    runId: hardStart.value.runId,
    proof,
  }, { method: 'PUT' });
  const hardEnd = await post(origin, '/api/prism/complete', {
    runId: hardStart.value.runId,
    ticket: bridge.value.bridgeTicket,
  }, { method: 'PATCH' });
  assert.equal(hardEnd.value.accepted, true);

  const noiseStart = await post(origin, '/api/aurora/open', { label: 'test-noise', sequence: 9 });
  assert.equal(noiseStart.value.channels.length, 36);
  const noiseEnd = await post(origin, '/api/aurora/close', {
    runId: noiseStart.value.runId,
    signal: noiseStart.value.channels[23].signal,
  }, { method: 'PUT' });
  assert.equal(noiseEnd.value.accepted, true);
});

test('gym website serves the challenge dashboard and browser runner', async (t) => {
  const gym = createGymServer();
  const origin = await gym.listen();
  t.after(() => gym.close());
  const page = await fetch(origin);
  const script = await fetch(`${origin}/app.js`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Features Farming Gym/);
  assert.equal(script.status, 200);
  assert.match(await script.text(), /window\.Gym/);
});

test('benchmark metrics record route coverage and completion', async (t) => {
  const gym = createGymServer();
  const origin = await gym.listen();
  t.after(() => gym.close());
  const run = 'metrics-test';
  const start = await post(origin, '/api/marble/session', { label: 'test' }, {
    headers: { 'x-gym-benchmark-run': run },
  });
  await post(origin, '/api/marble/confirm', {
    runId: start.value.runId,
    handoffKey: start.value.handoffKey,
  }, {
    method: 'PUT',
    headers: { 'x-gym-benchmark-run': run },
  });
  assert.deepEqual(gym.getMetrics(run), {
    requests: [
      { method: 'POST', route: '/api/marble/session', status: 200 },
      { method: 'PUT', route: '/api/marble/confirm', status: 200 },
    ],
    accepted: true,
  });
});

test('all V5 ground-truth transforms are accepted by their hidden evaluators', async (t) => {
  const gym = createGymServer();
  const origin = await gym.listen();
  t.after(() => gym.close());

  for (const [index, definition] of V5_CASES.entries()) {
    const label = `v5-test-${index}`;
    const opened = await post(origin, definition.routes.open, {
      label,
      sequence: index + 1,
    });
    assert.equal(opened.response.status, 200, definition.id);
    const proof = applyTransform(definition, { ...opened.value, label });
    const closed = await post(origin, definition.routes.close, {
      runId: opened.value.runId,
      proof,
    }, { method: 'PUT' });
    assert.equal(closed.value.accepted, true, definition.id);
  }
});
