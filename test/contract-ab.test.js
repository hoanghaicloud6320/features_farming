'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  evaluateContract,
  normalizeContractPath,
} = require('../scripts/run-keymanager-contract-ab');
const {
  aggregateArm,
  behavioralChecks,
  parseSeeds,
} = require('../scripts/run-keymanager-contract-multiseed');
const {
  evaluateSuite,
  normalizePath,
} = require('../scripts/run-contract-matrix');
const {
  addSemanticAutomationScore,
  aggregateRuns,
  evaluateExecutableReadiness,
  literalRouteMatches,
  validateAutomationCode,
} = require('../scripts/run-public-no-login-benchmark');

test('contract evaluator normalizes path parameters and scores statuses deterministically', () => {
  assert.equal(
    normalizeContractPath('/v1/licenses/7bade622-b72c-4182-9e5a-6affba227268'),
    '/v1/licenses/:param',
  );
  assert.equal(normalizeContractPath('/v1/licenses/{id}'), '/v1/licenses/:param');

  const inventory = [
    {
      method: 'GET',
      path: '/v1/licenses',
      observed: { statusCounts: { 200: 6 } },
    },
    {
      method: 'PATCH',
      path: '/v1/licenses/:uuid',
      observed: { statusCounts: { 200: 3 } },
    },
  ];
  const contract = {
    endpoints: [
      { method: 'GET', path: '/v1/licenses', observedStatuses: [200] },
      { method: 'PATCH', path: '/v1/licenses/{id}', observedStatuses: [201] },
      { method: 'DELETE', path: '/v1/invented', observedStatuses: [204] },
    ],
  };
  assert.deepEqual(evaluateContract(contract, inventory), {
    expectedEndpoints: 2,
    claimedEndpoints: 3,
    matchedEndpoints: 2,
    endpointCoverage: 1,
    hallucinatedEndpoints: ['DELETE /v1/invented'],
    exactStatusSets: 1,
    exactStatusSetAccuracy: 0.5,
  });
});

test('multi-seed aggregation reports worst-case and perfect-run rates', () => {
  assert.deepEqual(parseSeeds('11,13,17'), [11, 13, 17]);
  assert.throws(() => parseSeeds('11,11,17'), /unique/);
  assert.throws(() => parseSeeds('11,nope,17'), /integer seeds/);
  const runs = [
    {
      promptTokens: 100,
      evaluation: { endpointCoverage: 1, exactStatusSetAccuracy: 1, hallucinatedEndpoints: [] },
      behavior: { cookieAuthentication: true, namedAdminCookie: true, createToPatchDependency: true, createOrPatchToDeleteDependency: true },
    },
    {
      promptTokens: 120,
      evaluation: { endpointCoverage: 0.75, exactStatusSetAccuracy: 0.5, hallucinatedEndpoints: ['GET /invented'] },
      behavior: { cookieAuthentication: false, namedAdminCookie: false, createToPatchDependency: true, createOrPatchToDeleteDependency: false },
    },
  ];
  const aggregate = aggregateArm('features', runs);
  assert.deepEqual(aggregate.endpointCoverage, { min: 0.75, mean: 0.875, perfectRunRate: 0.5 });
  assert.deepEqual(aggregate.exactStatusSetAccuracy, { min: 0.5, mean: 0.75, perfectRunRate: 0.5 });
  assert.equal(aggregate.noHallucinationRate, 0.5);
  assert.deepEqual(aggregate.promptTokens, { min: 100, mean: 110, max: 120 });
});

test('behavioral contract checks recognize cookie auth and lifecycle dependencies', () => {
  const checks = behavioralChecks({
    authentication: { mechanism: 'Cookie-based session using km_admin' },
    workflows: [{
      dataFlow: [
        'POST /v1/admin/licenses response license.id to PATCH /v1/admin/licenses/:uuid',
        'PATCH response license.id to DELETE /v1/admin/licenses/:uuid',
      ],
    }],
  });
  assert.deepEqual(checks, {
    cookieAuthentication: true,
    namedAdminCookie: true,
    createToPatchDependency: true,
    createOrPatchToDeleteDependency: true,
  });
});

test('all-version contract evaluator matches numeric route templates and rejects noise', () => {
  assert.equal(normalizePath('/api/v8/88001/resource'), '/api/v8/:param/resource');
  assert.equal(normalizePath('/api/v8/:number/resource'), '/api/v8/:param/resource');
  const suite = {
    cases: [{
      id: 'case-1',
      truth: [{
        method: 'POST',
        path: '/api/v8/:number/resource',
        statuses: [201],
        requestFields: ['label'],
        responseFields: ['id'],
      }],
    }],
  };
  const evaluation = evaluateSuite(suite, {
    cases: [{
      caseId: 'case-1',
      endpoints: [
        {
          method: 'POST',
          path: '/api/v8/88001/resource',
          observedStatuses: [201],
          requestFields: ['label'],
          responseFields: ['id'],
        },
        {
          method: 'PATCH',
          path: '/api/v8/88001/events',
          observedStatuses: [202],
          requestFields: [],
          responseFields: [],
        },
      ],
    }],
  });
  assert.equal(evaluation.endpointRecall, 1);
  assert.equal(evaluation.endpointPrecision, 0.5);
  assert.equal(evaluation.exactStatusAccuracy, 1);
  assert.equal(evaluation.hallucinatedEndpoints, 1);
  assert.equal(evaluation.completeCaseRate, 0);
});

test('public benchmark detects memorized routes and blocks unsafe automation', () => {
  const definition = {
    truth: [{ path: '/api/private/:id' }],
  };
  assert.deepEqual(
    literalRouteMatches(
      definition,
      { cases: [{ endpoints: [{ path: '/api/private/:id' }] }] },
      '',
    ),
    ['/api/private/:id'],
  );
  assert.throws(
    () => validateAutomationCode(
      "require('node:fs'); fetch('https://example.test/api')",
      'https://example.test',
    ),
    /forbidden capability/,
  );
  assert.doesNotThrow(() => validateAutomationCode(
    "fetch('https://example.test/api').then(console.log)",
    'https://example.test',
  ));
});

test('public benchmark aggregation reports effectiveness and token efficiency', () => {
  const runs = [
    {
      arm: 'raw',
      contract: {
        promptTokens: 1000,
        evaluation: {
          qualityScore: 80,
          endpointF1: 1,
          exactStatusAccuracy: 1,
        },
      },
      automation: {
        promptTokens: 500,
        score: { accepted: true, exactAccepted: true, semanticAccepted: true },
      },
    },
    {
      arm: 'raw',
      contract: {
        promptTokens: 1000,
        evaluation: {
          qualityScore: 60,
          endpointF1: 0.5,
          exactStatusAccuracy: 0.5,
        },
      },
      automation: {
        promptTokens: 500,
        score: { accepted: false, exactAccepted: false, semanticAccepted: false },
      },
    },
  ];
  const aggregate = aggregateRuns(runs, 'raw');
  assert.equal(aggregate.meanContractQuality, 70);
  assert.equal(aggregate.automationPassRate, 0.5);
  assert.equal(aggregate.meanPromptTokensPerTarget, 1500);
  assert.equal(aggregate.contractQualityPer1kPromptTokens, 70);
});

test('public benchmark separates semantic success from exact output compliance', () => {
  const score = addSemanticAutomationScore(
    { id: 'tryscrapeme-ajax' },
    { count: 10, sum: 118.94 },
    { itemCount: 10, totalPrice: 118.94 },
    { accepted: false, checks: { exactFields: false } },
  );
  assert.equal(score.semanticAccepted, true);
  assert.equal(score.exactAccepted, false);
});

test('executable readiness checks representation, replay values and repeated flow', () => {
  const definition = {
    id: 'graphql',
    executionTruth: {
      representations: [{
        method: 'POST',
        path: '/api/graphql',
        requestBodyKinds: ['json'],
        responseBodyKinds: ['json-object'],
        responseContentTypes: ['application/json'],
      }],
      replayProfiles: [{
        endpoint: 'POST /api/graphql',
        field: 'body.json$.variables.first',
        observedValues: ['20'],
      }],
      flows: [{
        from: 'response.body.json$.pageInfo.endCursor',
        to: 'request.body.json$.variables.after',
      }],
      repeatedCalls: [{ endpoint: 'POST /api/graphql', count: 2 }],
    },
  };
  const contract = {
    cases: [{
      caseId: 'graphql',
      endpoints: [{
        method: 'POST',
        path: '/api/graphql',
        requestBodyKinds: ['json'],
        responseBodyKinds: ['json-object'],
        responseContentTypes: ['application/json'],
      }],
      replayProfiles: [{
        endpoint: 'POST /api/graphql',
        field: 'body.json$.variables.first',
        observedValues: ['20'],
      }],
      workflows: [{
        steps: ['POST /api/graphql #1', 'POST /api/graphql #2'],
        dataFlows: ['pageInfo.endCursor -> variables.after'],
      }],
    }],
  };
  assert.equal(evaluateExecutableReadiness(definition, contract).score, 100);
});
