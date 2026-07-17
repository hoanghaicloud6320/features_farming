'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { CHALLENGES } = require('../gym/challenges');
const {
  buildBudgetedEvidence,
  buildPrompt,
  compactRawContext,
  scoreResult,
  validateCode,
} = require('../src/gym-ab');

test('gym prompts differ only through supplied evidence and benchmark identity', () => {
  const common = {
    challenge: CHALLENGES.easy,
    origin: 'http://127.0.0.1:43127',
    benchmarkRunId: 'fixed-run',
  };
  const without = buildPrompt({ ...common, evidence: { rawTimeline: null, farmedFeatures: null } });
  const withFarm = buildPrompt({ ...common, evidence: { rawTimeline: null, farmedFeatures: { relation: 'x -> y' } } });
  assert.equal(
    without.slice(0, without.indexOf('EVIDENCE JSON:')),
    withFarm.slice(0, withFarm.indexOf('EVIDENCE JSON:')),
  );
});

test('gym validator accepts constrained localhost automation and rejects foreign hosts', () => {
  const origin = 'http://127.0.0.1:43127';
  const run = 'fixed-run';
  const valid = `
    const test = require('node:test');
    const assert = require('node:assert/strict');
    test('x', async () => {
      const response = await fetch('${origin}/api/x', { headers: { 'x-gym-benchmark-run': '${run}' } });
      assert.ok(response);
    });
  `;
  assert.doesNotThrow(() => validateCode(valid, origin, run));
  assert.throws(() => validateCode(valid.replace(`${origin}/api/x`, 'https://example.com/api/x'), origin, run));
  assert.throws(() => validateCode(valid.replace(
    "const test = require('node:test');",
    "import test from 'node:test';",
  ), origin, run));
});

test('gym score requires hidden acceptance for the majority of points', () => {
  const challenge = CHALLENGES.easy;
  const partial = scoreResult(challenge, { exitCode: 0 }, {
    accepted: false,
    requests: [{ route: challenge.routes[0] }],
  });
  const complete = scoreResult(challenge, { exitCode: 0 }, {
    accepted: true,
    requests: challenge.routes.map((route) => ({ route })),
  });
  assert.equal(partial.score, 2.5);
  assert.equal(complete.score, 10);
});

test('context budgeting keeps raw evidence valid and prioritizes features in the combined arm', () => {
  const largeBody = { values: Array.from({ length: 500 }, (_, index) => `value-${index}`) };
  const raw = {
    kind: 'raw',
    note: 'raw',
    sessions: [{
      recordingId: 'one',
      events: [
        { iterationId: 'i1', request: { url: 'http://x/open' }, response: { status: 200, body: largeBody } },
        { iterationId: 'i1', request: { url: 'http://x/close' }, response: { status: 200, body: {} } },
      ],
    }],
  };
  const compact = compactRawContext(raw, 5_000);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(compact)));
  assert.ok(JSON.stringify(compact).length <= 5_000);
  const evidence = buildBudgetedEvidence({
    condition: { raw: true, features: true },
    raw,
    features: {
      kind: 'features',
      collection: {},
      endpoints: [],
      relations: [{ sourceEndpoint: 'a', targetEndpoint: 'b' }],
      workflow: [],
      patterns: {},
      fields: [],
      schemas: [],
    },
    budgetChars: 6_000,
  });
  assert.ok(evidence.farmedFeatures);
  assert.ok(evidence.rawTimeline);
  assert.equal(evidence.budget.totalChars, 6_000);
});
