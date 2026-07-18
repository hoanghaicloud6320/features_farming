'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { CHALLENGES } = require('../gym/challenges');
const {
  buildBudgetedEvidence,
  buildFeatureContext,
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

test('feature compaction enforces its budget even with many relations', () => {
  const features = {
    kind: 'features',
    collection: { sessions: 3 },
    endpoints: [{
      signature: 'POST x/api/open?',
      classifications: ['core'],
    }],
    relations: Array.from({ length: 500 }, (_, index) => ({
      sourceEndpoint: 'POST x/api/open?',
      targetEndpoint: 'POST x/api/open?',
      kind: 'exact-copy',
      source: `field-${index}-${'x'.repeat(80)}`,
      target: `target-${index}-${'y'.repeat(80)}`,
      transforms: [],
    })),
    workflow: Array.from({ length: 100 }, (_, index) => ({ endpoint: `step-${index}` })),
    patterns: {},
    fields: [],
    schemas: [],
  };
  const compact = buildBudgetedEvidence({
    condition: { raw: false, features: true },
    raw: null,
    features,
    budgetChars: 5_000,
  });
  assert.ok(JSON.stringify(compact).length <= 5_000);
  assert.ok(compact.farmedFeatures.omitted.relations > 0);
  assert.equal(compact.farmedFeatures.endpoints.length, 1);
});

test('feature context warns when semantic sibling routes were generalized', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'feature-context-'));
  fs.writeFileSync(path.join(temporary, 'cross-session.json'), JSON.stringify({
    sessionCount: 3,
    iterationCount: 9,
    capturedRequestCount: 27,
    crossSessionEndpoints: [{
      routeKey: 'GET example.test/v1/admin/:var',
      signature: 'GET example.test/v1/admin/:var?limit',
      examples: [
        'https://example.test/v1/admin/session',
        'https://example.test/v1/admin/licenses?limit=100',
      ],
    }],
    crossSessionRelations: [],
    crossSessionRelationCandidates: [{
      kind: 'affine-numeric',
      promotion: { attentionEligible: false },
    }],
    consensusWorkflow: [],
    crossSessionFields: [],
    crossSessionSchemas: [],
    patternTotals: {},
  }));
  const context = buildFeatureContext(temporary);
  assert.equal(context.generalizationWarnings.length, 1);
  assert.deepEqual(context.generalizationWarnings[0].concreteExamples, [
    'GET /v1/admin/session',
    'GET /v1/admin/licenses?limit=100',
  ]);
  assert.deepEqual(context.diagnosticHypotheses, {
    retainedCount: 1,
    attentionEligible: false,
    artifact: 'relations.candidates.cross-session.json',
    note: 'Retained for analysis and future promotion; excluded from contract data flows.',
  });
});
