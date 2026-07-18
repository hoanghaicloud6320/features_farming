'use strict';

const {
  generateV6Suite,
  seededRandom,
} = require('./v6-cases');

function randomWord(random, length = 8) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  return Array.from({ length }, () => alphabet[Math.floor(random() * alphabet.length)]).join('');
}

function characterRotationCase(seed) {
  const random = seededRandom(seed ^ 0x71c3a5);
  const routeRoot = randomWord(random);
  const sourceField = randomWord(random, 7);
  const secondSourceField = randomWord(random, 7);
  const targetField = randomWord(random, 7);
  const base = `/api/v7/${seed}/${routeRoot}`;
  const definition = {
    id: `v7-${seed}-08-character-rotation`,
    seed,
    family: 'character-rotation-holdout',
    title: `character rotation holdout - ${routeRoot}`,
    routeRoot,
    fields: { sourceField, secondSourceField, targetField },
    noiseRequests: 8 + Math.floor(random() * 8),
    candidateCount: 20 + Math.floor(random() * 24),
    routes: {
      open: `${base}/${randomWord(random, 6)}`,
      close: `${base}/${randomWord(random, 6)}`,
      noise: `${base}/events`,
    },
    transform: {
      operation: 'character-rotation',
      shift: 2 + Math.floor(random() * 7),
    },
  };
  definition.groundTruth = {
    coreRoutes: [definition.routes.open, definition.routes.close],
    noiseRoutes: [definition.routes.noise],
    workflow: [definition.routes.open, definition.routes.close],
    relations: [
      {
        sourceRoute: 'open',
        sourceFields: ['response.body.json$.runId'],
        targetRoute: 'close',
        targetField: 'request.body.json$.runId',
        kind: 'exact-copy',
        transform: {},
      },
      {
        sourceRoute: 'open',
        sourceFields: [`response.body.json$.${sourceField}`],
        targetRoute: 'close',
        targetField: `request.body.json$.${targetField}`,
        kind: 'character-rotation',
        transform: { shift: definition.transform.shift },
      },
    ],
  };
  return definition;
}

function generateV7Suite(seed) {
  const suite = generateV6Suite(seed);
  return {
    ...suite,
    benchmark: 'farmer-gym-v7',
    cases: [...suite.cases, characterRotationCase(seed)],
  };
}

module.exports = {
  characterRotationCase,
  generateV7Suite,
};
