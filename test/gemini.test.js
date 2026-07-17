'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { validateGeneratedCode } = require('../src/automation-demo');
const { DEFAULT_MODEL, loadApiKeys } = require('../src/gemini');

test('loads one API key per line without exposing duplicates', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-keys-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'keys.txt');
  fs.writeFileSync(file, 'key-one\n\n# disabled\nkey-two\nkey-one\n');
  assert.deepEqual(loadApiKeys(file), ['key-one', 'key-two']);
  assert.equal(DEFAULT_MODEL, 'gemini-3.1-flash-lite');
});

test('accepts constrained automation and rejects unsafe generated code', () => {
  const safe = [
    "const test = require('node:test');",
    "const assert = require('node:assert/strict');",
    "test('demo', async () => {",
    "  const response = await fetch('https://api.artic.edu/api/v1/artworks?limit=1');",
    '  assert.equal(response.status, 200);',
    '});',
  ].join('\n');
  assert.doesNotThrow(() => validateGeneratedCode(safe));
  assert.throws(
    () => validateGeneratedCode(`${safe}\nrequire('node:child_process').exec('whoami');`),
    /rejected by safety policy/,
  );
  assert.throws(
    () => validateGeneratedCode(safe.replace('api.artic.edu', 'example.com')),
    /rejected by safety policy/,
  );
});
