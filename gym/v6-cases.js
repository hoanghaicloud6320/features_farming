'use strict';

const crypto = require('node:crypto');

const RELATION_FAMILIES = [
  'arbitrary-affix',
  'affine-numeric',
  'hmac-sha256',
  'json-base64url',
  'reverse-string',
  'array-selection',
];

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function choice(random, values) {
  return values[Math.floor(random() * values.length)];
}

function randomWord(random, parts = 3) {
  const syllables = ['za', 'qe', 'vo', 'xu', 'bi', 'ny', 'ka', 'fe', 'ru', 'jo', 'wi', 'po', 'cy', 'ga'];
  return Array.from({ length: parts }, () => choice(random, syllables)).join('');
}

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

function relationCase(seed, family, index, random) {
  const routeRoot = randomWord(random);
  const sourceField = randomWord(random);
  const secondSourceField = randomWord(random);
  const targetField = randomWord(random);
  const base = `/api/v6/${seed}/${routeRoot}`;
  const definition = {
    id: `v6-${seed}-${String(index + 1).padStart(2, '0')}-${family}`,
    seed,
    family,
    title: `${family} · ${routeRoot}`,
    routeRoot,
    fields: { sourceField, secondSourceField, targetField },
    noiseRequests: 6 + Math.floor(random() * 9),
    candidateCount: 12 + Math.floor(random() * 25),
    routes: {
      open: `${base}/${randomWord(random, 2)}`,
      close: `${base}/${randomWord(random, 2)}`,
      noise: `${base}/events`,
    },
  };
  let expected;
  if (family === 'arbitrary-affix') {
    definition.transform = {
      operation: family,
      prefix: `${randomWord(random, 2).toUpperCase()}::`,
      suffix: `::${randomWord(random, 2).toUpperCase()}`,
    };
    expected = relation(
      [`response.body.json$.${sourceField}`],
      `request.body.json$.${targetField}`,
      'substring-copy',
    );
  } else if (family === 'affine-numeric') {
    definition.transform = {
      operation: family,
      scale: 2 + Math.floor(random() * 7),
      offset: 11 + Math.floor(random() * 31),
    };
    expected = relation(
      [`response.body.json$.${sourceField}`],
      `request.body.json$.${targetField}`,
      'affine-numeric',
      { scale: definition.transform.scale, offset: definition.transform.offset },
    );
  } else if (family === 'hmac-sha256') {
    definition.transform = { operation: family, length: 24 + Math.floor(random() * 9) };
    expected = relation(
      [
        `response.body.json$.${sourceField}`,
        `response.body.json$.${secondSourceField}`,
        'request.body.json$.label',
      ],
      `request.body.json$.${targetField}`,
      'hmac-sha256',
      { algorithm: 'sha256', length: definition.transform.length },
    );
  } else if (family === 'json-base64url') {
    definition.transform = { operation: family };
    expected = relation(
      [
        `response.body.json$.${sourceField}`,
        `response.body.json$.${secondSourceField}`,
        'request.body.json$.label',
      ],
      `request.body.json$.${targetField}`,
      'json-base64url',
    );
  } else if (family === 'reverse-string') {
    definition.transform = { operation: family };
    expected = relation(
      [`response.body.json$.${sourceField}`],
      `request.body.json$.${targetField}`,
      'reverse-copy',
    );
  } else if (family === 'array-selection') {
    definition.transform = { operation: family, selectedIndex: 2 + Math.floor(random() * 4) };
    expected = relation(
      [`response.body.json$.payloads[${definition.transform.selectedIndex}].${sourceField}`],
      `request.body.json$.${targetField}`,
      'exact-copy',
    );
  }
  definition.groundTruth = {
    coreRoutes: [definition.routes.open, definition.routes.close],
    noiseRoutes: [definition.routes.noise],
    workflow: [definition.routes.open, definition.routes.close],
    relations: [
      relation(['response.body.json$.runId'], 'request.body.json$.runId', 'exact-copy'),
      expected,
    ],
  };
  return definition;
}

function semanticSiblingCase(seed, index, random) {
  const base = `/api/v6/${seed}/${randomWord(random)}`;
  const actions = [randomWord(random, 2), randomWord(random, 2), randomWord(random, 2)];
  const schemaFields = [randomWord(random), randomWord(random), randomWord(random)];
  return {
    id: `v6-${seed}-${String(index + 1).padStart(2, '0')}-semantic-siblings`,
    seed,
    family: 'semantic-siblings',
    title: `semantic-siblings · ${base.split('/').at(-1)}`,
    base,
    actions,
    schemaFields,
    statuses: [200, 202, 207],
    noiseRequests: 3 + Math.floor(random() * 4),
    noiseRoute: `${base}/events`,
    routes: Object.fromEntries(actions.map((action, actionIndex) => (
      [`member${actionIndex + 1}`, `${base}/${action}`]
    ))),
    groundTruth: {
      members: actions.map((action, actionIndex) => ({
        method: 'GET',
        path: `${base}/${action}`,
        status: [200, 202, 207][actionIndex],
        responseField: `$.${schemaFields[actionIndex]}`,
      })),
    },
  };
}

function generateV6Suite(seed) {
  if (!Number.isInteger(seed)) throw new Error('V6 seed must be an integer');
  const random = seededRandom(seed);
  const cases = RELATION_FAMILIES.map((family, index) => relationCase(seed, family, index, random));
  cases.push(semanticSiblingCase(seed, cases.length, random));
  return {
    schemaVersion: 1,
    benchmark: 'farmer-gym-v6',
    seed,
    cases,
  };
}

function deterministicValue(definition, sessionNumber, iteration, label) {
  const digest = crypto.createHash('sha256')
    .update(`${definition.seed}|${definition.id}|${sessionNumber}|${iteration}|${label}`)
    .digest('hex');
  return {
    source: `${definition.fields?.sourceField || 'source'}-${digest.slice(0, 18)}`,
    secondSource: `${definition.fields?.secondSourceField || 'second'}-${digest.slice(18, 36)}`,
    number: Number.parseInt(digest.slice(0, 8), 16) % 10_000 + 100,
  };
}

function applyV6Transform(definition, values, label) {
  const transform = definition.transform;
  if (transform.operation === 'arbitrary-affix') {
    return `${transform.prefix}${values.source}${transform.suffix}`;
  }
  if (transform.operation === 'affine-numeric') {
    return (values.number * transform.scale) + transform.offset;
  }
  if (transform.operation === 'hmac-sha256') {
    return crypto.createHmac('sha256', values.source)
      .update(`${values.secondSource}|${label}`)
      .digest('hex')
      .slice(0, transform.length);
  }
  if (transform.operation === 'json-base64url') {
    return Buffer.from(JSON.stringify({
      a: values.source,
      b: values.secondSource,
      label,
    }), 'utf8').toString('base64url');
  }
  if (transform.operation === 'reverse-string') {
    return [...values.source].reverse().join('');
  }
  if (transform.operation === 'array-selection') {
    return values.payloads[transform.selectedIndex][definition.fields.sourceField];
  }
  if (transform.operation === 'character-rotation') {
    const shift = transform.shift % values.source.length;
    return `${values.source.slice(shift)}${values.source.slice(0, shift)}`;
  }
  throw new Error(`Unsupported V6 transform: ${transform.operation}`);
}

module.exports = {
  RELATION_FAMILIES,
  applyV6Transform,
  deterministicValue,
  generateV6Suite,
  seededRandom,
};
