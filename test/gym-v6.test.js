'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  RELATION_FAMILIES,
  applyV6Transform,
  generateV6Suite,
} = require('../gym/v6-cases');
const { writeV6Recording } = require('../gym/v6-recording');
const { generateV7Suite } = require('../gym/v7-cases');
const { farmInput } = require('../src/collection');
const { evaluateFarmerOutput } = require('../src/gym-v5');
const { evaluateSemanticSiblings } = require('../src/gym-v6');
const { parseSeeds } = require('../scripts/run-gym-v6');

test('V6 suites are reproducible per seed and novel across seeds', () => {
  const first = generateV6Suite(73_001);
  const repeated = generateV6Suite(73_001);
  const other = generateV6Suite(73_019);
  assert.deepEqual(first, repeated);
  assert.notDeepEqual(first.cases.map((item) => item.routes), other.cases.map((item) => item.routes));
  assert.deepEqual(first.cases.slice(0, RELATION_FAMILIES.length).map((item) => item.family), RELATION_FAMILIES);
  assert.equal(first.cases.at(-1).family, 'semantic-siblings');
  assert.deepEqual(parseSeeds('73001,73019'), [73_001, 73_019]);
  assert.throws(() => parseSeeds('73001,nope'), /integer seeds/);
});

test('V6 novel transforms follow their independent ground truth', () => {
  const suite = generateV6Suite(73_001);
  const values = {
    source: 'alpha-123',
    secondSource: 'bravo-456',
    number: 71,
    payloads: [],
  };
  for (const definition of suite.cases.filter((item) => item.transform)) {
    values.payloads = Array.from({ length: 8 }, (_, index) => ({
      [definition.fields.sourceField]: `selected-${index}`,
    }));
    const proof = applyV6Transform(definition, values, 'sample-label');
    if (definition.family === 'arbitrary-affix') {
      assert.ok(proof.startsWith(definition.transform.prefix));
      assert.ok(proof.endsWith(definition.transform.suffix));
    } else if (definition.family === 'affine-numeric') {
      assert.equal(proof, (values.number * definition.transform.scale) + definition.transform.offset);
    } else if (definition.family === 'hmac-sha256') {
      assert.equal(proof.length, definition.transform.length);
    } else if (definition.family === 'json-base64url') {
      assert.deepEqual(JSON.parse(Buffer.from(proof, 'base64url').toString('utf8')), {
        a: values.source,
        b: values.secondSource,
        label: 'sample-label',
      });
    } else if (definition.family === 'reverse-string') {
      assert.equal(proof, '321-ahpla');
    } else if (definition.family === 'array-selection') {
      assert.equal(proof, `selected-${definition.transform.selectedIndex}`);
    }
  }
});

test('V6 semantic siblings preserve randomized status and schema attribution', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-v6-siblings-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const definition = generateV6Suite(73_001).cases.at(-1);
  const recordings = path.join(root, 'recordings');
  for (let sessionNumber = 1; sessionNumber <= 2; sessionNumber += 1) {
    writeV6Recording({
      definition,
      directory: path.join(recordings, `session-${sessionNumber}`),
      sessionNumber,
      iterationCount: 3,
    });
  }
  const farmed = await farmInput({
    inputDirectory: recordings,
    outputDirectory: path.join(root, 'features'),
  });
  const single = evaluateSemanticSiblings(definition, farmed.sessionResults[0].result, 'single', 3);
  const cross = evaluateSemanticSiblings(definition, farmed.summary, 'cross-session', 2);
  assert.equal(single.score, 100);
  assert.equal(cross.score, 100);
});

test('bounded transform detectors recover all known families on a fresh seed', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-v6-detectors-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const definitions = generateV6Suite(79_919).cases.filter((item) => item.transform);
  for (const definition of definitions) {
    const recordings = path.join(root, definition.id, 'recordings');
    writeV6Recording({
      definition,
      directory: path.join(recordings, 'session-1'),
      sessionNumber: 1,
      iterationCount: 4,
    });
    const farmed = await farmInput({
      inputDirectory: recordings,
      outputDirectory: path.join(root, definition.id, 'features'),
    });
    const score = evaluateFarmerOutput(
      definition,
      farmed.sessionResults[0].result,
      'single',
    );
    assert.equal(score.relations.recall, 1, definition.family);
  }
});

test('V7 adds a deterministic transform family held out from the detectors', () => {
  const first = generateV7Suite(81_017);
  const repeated = generateV7Suite(81_017);
  assert.deepEqual(first, repeated);
  const holdout = first.cases.at(-1);
  assert.equal(holdout.family, 'character-rotation-holdout');
  assert.equal(holdout.groundTruth.relations.at(-1).kind, 'character-rotation');
  const transformed = applyV6Transform(holdout, {
    source: 'abcdefghij',
    secondSource: 'unused',
  }, 'unused');
  const shift = holdout.transform.shift;
  assert.equal(transformed, `abcdefghij`.slice(shift) + `abcdefghij`.slice(0, shift));
});
