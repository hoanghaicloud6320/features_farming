'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { V5_CASES } = require('../gym/v5-cases');
const { evaluateFarmerOutput } = require('../src/gym-v5');

function relationFor(definition, expected) {
  return {
    kind: expected.kind,
    source: {
      endpointId: expected.sourceRoute,
      endpoint: `POST 127.0.0.1${definition.routes[expected.sourceRoute]}?`,
      display: expected.sourceFields[0],
    },
    sources: expected.sourceFields.map((field) => ({
      endpoint: `POST 127.0.0.1${definition.routes[expected.sourceRoute]}?`,
      display: field,
    })),
    target: {
      endpointId: expected.targetRoute,
      endpoint: `PUT 127.0.0.1${definition.routes[expected.targetRoute]}?`,
      display: expected.targetField,
    },
    transform: expected.transform,
  };
}

test('V5 has four cases on each requested validation axis', () => {
  assert.equal(V5_CASES.length, 12);
  const counts = {};
  for (const definition of V5_CASES) {
    counts[definition.axis.id] = (counts[definition.axis.id] || 0) + 1;
  }
  assert.deepEqual(
    counts,
    {
      'simple-noise': 4,
      'hard-clean': 4,
      'hard-noise': 4,
    },
  );
});

test('farmer V5 evaluator awards a perfect result only for matching ground truth', () => {
  const definition = V5_CASES.find((item) => item.id === 'hard-sha256-noise');
  const output = {
    endpoints: [
      ...definition.groundTruth.coreRoutes.map((route) => ({
        id: route.endsWith('/open') ? 'open' : 'close',
        signature: `POST 127.0.0.1${route}?`,
        classifications: 'core',
      })),
      ...definition.groundTruth.noiseRoutes.map((route) => ({
        signature: `POST 127.0.0.1${route}?`,
        classifications: 'telemetry-noise',
      })),
    ],
    workflow: definition.groundTruth.workflow.map((route) => ({
      endpoint: `POST 127.0.0.1${route}?`,
    })),
    relations: definition.groundTruth.relations.map((expected) => relationFor(definition, expected)),
  };
  const perfect = evaluateFarmerOutput(definition, output, 'single');
  assert.equal(perfect.score, 100);
  assert.equal(perfect.relations.recall, 1);

  output.relations = output.relations.filter((relation) => relation.kind !== 'hash-derived-copy');
  const missingTransform = evaluateFarmerOutput(definition, output, 'single');
  assert.equal(missingTransform.relations.recall, 0.5);
  assert.ok(missingTransform.score < perfect.score);
});
