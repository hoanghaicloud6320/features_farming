'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildLineageIndex } = require('../src/lineage');

function point(fieldPath) {
  return {
    routeKey: 'POST example.test/resource?',
    side: fieldPath === '$.a' ? 'response' : 'request',
    location: 'body.json',
    fieldPath,
  };
}

function relation(id, kind, sourceField, targetField, transform) {
  return {
    id,
    kind,
    source: point(sourceField),
    sources: [point(sourceField)],
    target: point(targetField),
    sessionPresence: 3,
    supportIterations: 9,
    averageConfidence: 0.9,
    medianRequestDistance: 1,
    transforms: transform ? [transform] : [],
    sessionSupport: [{ sessionId: 'session-a', relationId: `${id}-a` }],
  };
}

test('lineage compression preserves every direct edge behind a smaller backbone', () => {
  const relations = [
    relation('ab', 'exact-copy', '$.a', '$.b'),
    relation('bc', 'exact-copy', '$.b', '$.c'),
    relation('ac', 'exact-copy', '$.a', '$.c'),
    relation('cd', 'reverse-copy', '$.c', '$.d', { operation: 'reverse-string' }),
  ];
  const lineage = buildLineageIndex(relations);
  assert.equal(lineage.stats.exactDirectEdgeCount, 3);
  assert.equal(lineage.stats.backboneEdgeCount, 2);
  assert.equal(lineage.stats.redundantExactEdgeCount, 1);
  assert.equal(lineage.stats.transformEdgeCount, 1);
  assert.equal(lineage.lineageGroups.length, 1);
  assert.deepEqual(
    new Set(lineage.lineageGroups[0].directEdgeIds),
    new Set(['ab', 'bc', 'ac']),
  );
  assert.equal(lineage.lineageGroups[0].backboneEdgeIds.length, 2);
  assert.equal(lineage.lineageGroups[0].redundantEdgeIds.length, 1);
  assert.deepEqual(lineage.directExactEdges.find((edge) => edge.id === 'ab').sessionSupport, [
    { sessionId: 'session-a', relationId: 'ab-a' },
  ]);
});
