'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  V8_CONFIGURATIONS,
  generateV8Suite,
} = require('../gym/v8-cases');
const { writeV8Recording } = require('../gym/v8-recording');
const { farmInput } = require('../src/collection');
const {
  evaluateV8Case,
  expectedEdges,
  expectedPoints,
} = require('../src/gym-v8');

test('V8 creates exactly five randomized cases per compression configuration', () => {
  const suite = generateV8Suite(88_001);
  const repeated = generateV8Suite(88_001);
  const other = generateV8Suite(88_019);
  assert.deepEqual(suite, repeated);
  assert.notDeepEqual(suite.cases, other.cases);
  assert.equal(suite.cases.length, V8_CONFIGURATIONS.length * 5);
  for (const configuration of V8_CONFIGURATIONS) {
    assert.equal(
      suite.cases.filter((item) => item.configuration === configuration).length,
      5,
    );
  }
});

test('V8 ground truth derives dense direct edges independently from lineage output', () => {
  const definition = generateV8Suite(88_001).cases
    .find((item) => item.configuration === 'crud-dense');
  const points = expectedPoints(definition, definition.lineages[0]);
  assert.equal(points.length, 5);
  assert.equal(expectedEdges(points).length, 10);
});

test('V8 integration preserves lineage power across every configuration', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-v8-lineage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const suite = generateV8Suite(89_003);
  for (const configuration of V8_CONFIGURATIONS) {
    const definition = suite.cases.find((item) => item.configuration === configuration);
    const recordings = path.join(root, definition.id, 'recordings');
    for (let sessionNumber = 1; sessionNumber <= 2; sessionNumber += 1) {
      writeV8Recording({
        definition,
        directory: path.join(recordings, `session-${sessionNumber}`),
        sessionNumber,
        iterationCount: 3,
      });
    }
    const farmed = await farmInput({
      inputDirectory: recordings,
      outputDirectory: path.join(root, definition.id, 'features'),
    });
    assert.equal(evaluateV8Case(definition, farmed).score, 100, configuration);
  }
});
