'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildAbPrompt, scoreGeneratedAutomations } = require('../src/ab-demo');

test('A/B prompts differ only in the evidence payload', () => {
  const marker = { endpoints: [{ signature: 'POST example' }] };
  const noFeatures = buildAbPrompt(null);
  const withFeatures = buildAbPrompt(marker);
  const prefixA = noFeatures.slice(0, noFeatures.indexOf('EVIDENCE:'));
  const prefixB = withFeatures.slice(0, withFeatures.indexOf('EVIDENCE:'));
  assert.equal(prefixA, prefixB);
  assert.match(noFeatures, /EVIDENCE:\nnull$/);
  assert.match(withFeatures, /"signature": "POST example"/);
});

test('automation rubric rewards concrete search-to-detail behavior', () => {
  const code = `
    const { test } = require('node:test');
    const assert = require('node:assert/strict');
    test('workflow', async () => {
      const search = await fetch('https://api.artic.edu/api/v1/artworks/search', {
        method: 'POST',
        body: JSON.stringify({ q: 'netsuke', size: 3, fields: ['id'], query: { term: { is_public_domain: true } } })
      });
      assert.equal(search.status, 200);
      const payload = await search.json();
      assert.ok(Array.isArray(payload.data));
      const id = payload.data[0].id;
      const detail = await fetch(\`https://api.artic.edu/api/v1/artworks/\${id}\`);
      assert.equal(detail.status, 200);
      const detailPayload = await detail.json();
      assert.equal(detailPayload.data.id, id);
    });
  `;
  const scored = scoreGeneratedAutomations([{ code }]);
  assert.ok(scored.score >= 10, JSON.stringify(scored));
});
