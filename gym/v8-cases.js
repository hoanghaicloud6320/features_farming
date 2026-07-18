'use strict';

const crypto = require('node:crypto');
const { seededRandom } = require('./v6-cases');

const V8_CONFIGURATIONS = [
  'crud-dense',
  'session-fanout',
  'parallel-identities',
  'semantic-siblings',
  'optional-session',
];

function choice(random, values) {
  return values[Math.floor(random() * values.length)];
}

function randomWord(random, length = 8) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  return Array.from({ length }, () => choice(random, alphabet)).join('');
}

function link(lineage, field, location = 'body') {
  return { lineage, field, location };
}

function step(role, method, route, requestLinks = [], responseLinks = []) {
  return { role, method, route, requestLinks, responseLinks };
}

function buildConfigurationCase(seed, configuration, caseNumber, random) {
  const namespace = randomWord(random);
  const base = `/api/v8/${seed}/${namespace}`;
  const primary = randomWord(random, 7);
  const secondary = randomWord(random, 7);
  const routes = (count) => Array.from(
    { length: count },
    () => `${base}/${randomWord(random, 6)}`,
  );
  let steps;
  let lineages;

  if (configuration === 'crud-dense') {
    const paths = routes(5);
    lineages = [{ id: 'resource', scope: 'actionable' }];
    steps = [
      step('create', 'POST', paths[0], [], [link('resource', primary)]),
      step('detail', 'GET', paths[1], [link('resource', primary, 'query')]),
      step('update', 'PATCH', paths[2], [link('resource', primary)]),
      step('audit', 'POST', paths[3], [link('resource', primary)]),
      step('delete', 'DELETE', paths[4], [link('resource', primary)]),
    ];
  } else if (configuration === 'session-fanout') {
    const paths = routes(5);
    lineages = [{ id: 'session', scope: 'actionable' }];
    steps = [
      step('login', 'POST', paths[0], [], [link('session', primary)]),
      step('profile', 'GET', paths[1], [link('session', primary, 'query')]),
      step('preferences', 'PUT', paths[2], [link('session', primary)]),
      step('orders', 'POST', paths[3], [link('session', primary)]),
      step('logout', 'DELETE', paths[4], [link('session', primary)]),
    ];
  } else if (configuration === 'parallel-identities') {
    const paths = routes(4);
    lineages = [
      { id: 'account', scope: 'actionable' },
      { id: 'order', scope: 'actionable' },
    ];
    steps = [
      step('create', 'POST', paths[0], [], [
        link('account', primary),
        link('order', secondary),
      ]),
      ...['detail', 'payment', 'receipt'].map((role, index) => step(
        role,
        index === 0 ? 'GET' : 'POST',
        paths[index + 1],
        [
          link('account', primary),
          link('order', secondary),
        ],
      )),
    ];
  } else if (configuration === 'semantic-siblings') {
    const actions = [randomWord(random, 6), randomWord(random, 6), randomWord(random, 6)];
    const target = `${base}/${randomWord(random, 6)}`;
    lineages = [{ id: 'workspace', scope: 'actionable' }];
    steps = [
      ...actions.map((action, index) => step(
        `sibling-${index + 1}`,
        'GET',
        `${base}/${action}`,
        [],
        [link('workspace', primary)],
      )),
      step('aggregate', 'POST', target, [link('workspace', primary)]),
    ];
  } else if (configuration === 'optional-session') {
    const paths = routes(3);
    lineages = [
      { id: 'stable', scope: 'actionable' },
      { id: 'optional', scope: 'candidate-only', activeSessions: [1] },
    ];
    steps = [
      step('open', 'POST', paths[0], [], [
        link('stable', primary),
        link('optional', secondary),
      ]),
      step('inspect', 'GET', paths[1], [
        link('stable', primary, 'query'),
        link('optional', secondary, 'query'),
      ]),
      step('close', 'PUT', paths[2], [
        link('stable', primary),
        link('optional', secondary),
      ]),
    ];
  } else {
    throw new Error(`Unsupported V8 configuration: ${configuration}`);
  }

  return {
    id: `v8-${seed}-${configuration}-${String(caseNumber).padStart(2, '0')}`,
    seed,
    configuration,
    caseNumber,
    namespace,
    title: `${configuration} randomized case ${caseNumber}`,
    noiseRoute: `${base}/events`,
    noiseRequests: 2 + Math.floor(random() * 6),
    steps,
    lineages,
  };
}

function generateV8Suite(seed = 88_001) {
  if (!Number.isInteger(seed)) throw new Error('V8 seed must be an integer');
  const random = seededRandom(seed);
  const cases = [];
  for (const configuration of V8_CONFIGURATIONS) {
    for (let caseNumber = 1; caseNumber <= 5; caseNumber += 1) {
      cases.push(buildConfigurationCase(seed, configuration, caseNumber, random));
    }
  }
  return {
    schemaVersion: 1,
    benchmark: 'farmer-gym-v8-lineage-compression',
    seed,
    configurations: V8_CONFIGURATIONS,
    cases,
  };
}

function lineageValue(definition, lineageId, sessionNumber, iteration) {
  return `${lineageId}-${crypto.createHash('sha256')
    .update(`${definition.seed}|${definition.id}|${lineageId}|${sessionNumber}|${iteration}`)
    .digest('hex')
    .slice(0, 18)}`;
}

module.exports = {
  V8_CONFIGURATIONS,
  generateV8Suite,
  lineageValue,
};
