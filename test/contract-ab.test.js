'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  evaluateContract,
  normalizeContractPath,
} = require('../scripts/run-keymanager-contract-ab');

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
