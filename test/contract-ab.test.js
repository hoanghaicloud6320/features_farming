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
