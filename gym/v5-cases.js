'use strict';

const crypto = require('node:crypto');

const AXES = {
  simpleNoise: {
    id: 'simple-noise',
    label: 'Simple transform · high noise',
    description: 'Common, directly explainable transforms hidden inside heavy telemetry.',
  },
  hardClean: {
    id: 'hard-clean',
    label: 'Hard transform · low noise',
    description: 'Hash-derived dependencies with almost no distracting traffic.',
  },
  hardNoise: {
    id: 'hard-noise',
    label: 'Hard transform · high noise',
    description: 'Hash-derived dependencies mixed with telemetry and plausible decoy values.',
  },
};

function relation(sourceFields, targetField, kind, transform = {}) {
  return {
    sourceRoute: 'open',
    sourceFields,
    targetRoute: 'close',
    targetField,
    kind,
    transform,
  };
}

function caseDefinition({
  id,
  title,
  axis,
  transform,
  noiseRequests,
  candidateCount = 0,
  expectedKind,
  expectedTransform = {},
  sourceFields,
}) {
  const base = `/api/v5/${id}`;
  return {
    id,
    title,
    axis: AXES[axis],
    transform,
    noiseRequests,
    candidateCount,
    routes: {
      open: `${base}/open`,
      close: `${base}/close`,
      noise: `${base}/events`,
    },
    groundTruth: {
      coreRoutes: [`${base}/open`, `${base}/close`],
      noiseRoutes: noiseRequests ? [`${base}/events`] : [],
      workflow: [`${base}/open`, `${base}/close`],
      relations: [
        relation(['response.body.json$.runId'], 'request.body.json$.runId', 'exact-copy'),
        relation(sourceFields, 'request.body.json$.proof', expectedKind, expectedTransform),
      ],
    },
  };
}

const V5_CASES = [
  caseDefinition({
    id: 'simple-exact-noise',
    title: 'Exact Needle',
    axis: 'simpleNoise',
    transform: { operation: 'exact', field: 'token' },
    noiseRequests: 24,
    candidateCount: 48,
    sourceFields: ['response.body.json$.token'],
    expectedKind: 'exact-copy',
  }),
  caseDefinition({
    id: 'simple-base64-noise',
    title: 'Base64 Beacon',
    axis: 'simpleNoise',
    transform: { operation: 'base64url' },
    noiseRequests: 24,
    candidateCount: 36,
    sourceFields: ['response.body.json$.capsule'],
    expectedKind: 'base64-decoded-copy',
    expectedTransform: { operation: 'base64url-encode-utf8' },
  }),
  caseDefinition({
    id: 'simple-case-noise',
    title: 'Uppercase Lantern',
    axis: 'simpleNoise',
    transform: { operation: 'uppercase' },
    noiseRequests: 24,
    candidateCount: 36,
    sourceFields: ['response.body.json$.token'],
    expectedKind: 'case-normalized-copy',
    expectedTransform: { operation: 'uppercase' },
  }),
  caseDefinition({
    id: 'simple-prefix-noise',
    title: 'Prefix Marker',
    axis: 'simpleNoise',
    transform: { operation: 'prefix', value: 'MARKER-' },
    noiseRequests: 24,
    candidateCount: 36,
    sourceFields: ['response.body.json$.token'],
    expectedKind: 'suffix-copy',
  }),
  caseDefinition({
    id: 'hard-sha256-clean',
    title: 'SHA-256 Triple',
    axis: 'hardClean',
    transform: { operation: 'hash', algorithm: 'sha256', fields: ['seed', 'salt', 'label'], delimiter: ':', length: 24 },
    noiseRequests: 0,
    sourceFields: [
      'response.body.json$.seed',
      'response.body.json$.salt',
      'request.body.json$.label',
    ],
    expectedKind: 'hash-derived-copy',
    expectedTransform: { algorithm: 'sha256', delimiter: ':', length: 24 },
  }),
  caseDefinition({
    id: 'hard-sha1-clean',
    title: 'SHA-1 Pair',
    axis: 'hardClean',
    transform: { operation: 'hash', algorithm: 'sha1', fields: ['nonce', 'label'], delimiter: '|', length: 32 },
    noiseRequests: 0,
    sourceFields: ['response.body.json$.nonce', 'request.body.json$.label'],
    expectedKind: 'hash-derived-copy',
    expectedTransform: { algorithm: 'sha1', delimiter: '|', length: 32 },
  }),
  caseDefinition({
    id: 'hard-md5-clean',
    title: 'MD5 Ordered Triple',
    axis: 'hardClean',
    transform: { operation: 'hash', algorithm: 'md5', fields: ['salt', 'seed', 'label'], delimiter: '-', length: 32 },
    noiseRequests: 0,
    sourceFields: [
      'response.body.json$.salt',
      'response.body.json$.seed',
      'request.body.json$.label',
    ],
    expectedKind: 'hash-derived-copy',
    expectedTransform: { algorithm: 'md5', delimiter: '-', length: 32 },
  }),
  caseDefinition({
    id: 'hard-sha256-nodelim-clean',
    title: 'SHA-256 Tight Join',
    axis: 'hardClean',
    transform: { operation: 'hash', algorithm: 'sha256', fields: ['seed', 'nonce', 'label'], delimiter: '', length: 40 },
    noiseRequests: 0,
    sourceFields: [
      'response.body.json$.seed',
      'response.body.json$.nonce',
      'request.body.json$.label',
    ],
    expectedKind: 'hash-derived-copy',
    expectedTransform: { algorithm: 'sha256', delimiter: '', length: 40 },
  }),
  caseDefinition({
    id: 'hard-sha256-noise',
    title: 'SHA-256 Storm',
    axis: 'hardNoise',
    transform: { operation: 'hash', algorithm: 'sha256', fields: ['seed', 'salt', 'label'], delimiter: ':', length: 24 },
    noiseRequests: 30,
    candidateCount: 48,
    sourceFields: [
      'response.body.json$.seed',
      'response.body.json$.salt',
      'request.body.json$.label',
    ],
    expectedKind: 'hash-derived-copy',
    expectedTransform: { algorithm: 'sha256', delimiter: ':', length: 24 },
  }),
  caseDefinition({
    id: 'hard-sha1-noise',
    title: 'SHA-1 Fog',
    axis: 'hardNoise',
    transform: { operation: 'hash', algorithm: 'sha1', fields: ['nonce', 'label'], delimiter: '.', length: 36 },
    noiseRequests: 30,
    candidateCount: 48,
    sourceFields: ['response.body.json$.nonce', 'request.body.json$.label'],
    expectedKind: 'hash-derived-copy',
    expectedTransform: { algorithm: 'sha1', delimiter: '.', length: 36 },
  }),
  caseDefinition({
    id: 'hard-md5-noise',
    title: 'MD5 Decoy Field',
    axis: 'hardNoise',
    transform: { operation: 'hash', algorithm: 'md5', fields: ['salt', 'seed', 'label'], delimiter: '/', length: 28 },
    noiseRequests: 30,
    candidateCount: 48,
    sourceFields: [
      'response.body.json$.salt',
      'response.body.json$.seed',
      'request.body.json$.label',
    ],
    expectedKind: 'hash-derived-copy',
    expectedTransform: { algorithm: 'md5', delimiter: '/', length: 28 },
  }),
  caseDefinition({
    id: 'hard-sha256-candidate-noise',
    title: 'SHA-256 Candidate Maze',
    axis: 'hardNoise',
    transform: { operation: 'hash', algorithm: 'sha256', fields: ['challenge', 'nonce', 'label'], delimiter: '-', length: 32 },
    noiseRequests: 36,
    candidateCount: 64,
    sourceFields: [
      'response.body.json$.challenge',
      'response.body.json$.nonce',
      'request.body.json$.label',
    ],
    expectedKind: 'hash-derived-copy',
    expectedTransform: { algorithm: 'sha256', delimiter: '-', length: 32 },
  }),
];

const V5_CASE_BY_ID = new Map(V5_CASES.map((item) => [item.id, item]));

function applyTransform(definition, values) {
  const spec = definition.transform;
  if (spec.operation === 'exact') return values[spec.field];
  if (spec.operation === 'base64url') return Buffer.from(values.capsule, 'utf8').toString('base64url');
  if (spec.operation === 'uppercase') return values.token.toUpperCase();
  if (spec.operation === 'prefix') return `${spec.value}${values.token}`;
  if (spec.operation === 'hash') {
    const input = spec.fields.map((field) => values[field]).join(spec.delimiter);
    return crypto.createHash(spec.algorithm).update(input, 'utf8').digest('hex').slice(0, spec.length);
  }
  throw new Error(`Unsupported V5 transform: ${spec.operation}`);
}

module.exports = {
  AXES,
  V5_CASES,
  V5_CASE_BY_ID,
  applyTransform,
};
