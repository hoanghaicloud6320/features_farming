#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { generateJsonWithFallback, loadApiKeys } = require('../src/gemini');
const { CONTRACT_SCHEMA, renderContract } = require('./run-keymanager-contract-ab');

async function main() {
  const workspace = path.resolve(__dirname, '..');
  const resultRoot = path.join(workspace, 'generated', 'keymanager-contract-ab');
  const evidenceFile = path.join(resultRoot, 'features', 'evidence.json');
  if (!fs.existsSync(evidenceFile)) {
    throw new Error('Run npm run keymanager:contract-ab before the feature-unroll diagnostic');
  }
  const evidence = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));
  const prompt = [
    'You are producing a concrete API contract from machine-farmed browser-traffic features.',
    'Do not generate automation tests. A short Node.js fetch sample is optional.',
    'Do not invent endpoints, fields, statuses, authentication mechanisms, or semantics.',
    'The farmer may generalize stable sibling path segments as :var.',
    'UNROLL RULE: when endpoint examples, fields, relations, schemas, or workflow evidence name concrete sibling paths, emit each supported concrete method + path as its own endpoint.',
    'Do not retain a :var endpoint when the evidence supports its finite concrete alternatives.',
    'Every unrolled endpoint must include a warning that sibling-specific request fields, response schemas, query keys, and statuses may differ unless evidence explicitly associates them with that concrete sibling.',
    'Do not inherit aggregated statuses or schemas from the :var family. Use an empty status list and mark details inferred/unknown when per-sibling attribution is absent.',
    'If the concrete alternatives are not supported by evidence, retain the generalized form and state the uncertainty.',
    'Mark every endpoint as observed, inferred, or unknown.',
    'Describe request and response shapes compactly in plain text.',
    'Keep redacted values redacted; never attempt to reconstruct secrets.',
    '',
    'EVIDENCE JSON:',
    JSON.stringify(evidence, null, 2),
  ].join('\n');
  const generated = await generateJsonWithFallback({
    apiKeys: loadApiKeys(path.join(workspace, 'gemini-api-key.txt')),
    prompt,
    responseJsonSchema: CONTRACT_SCHEMA,
    maxOutputTokens: 12_000,
    seed: 95_501,
  });
  const outputRoot = path.join(resultRoot, 'features-unrolled');
  fs.mkdirSync(outputRoot, { recursive: true });
  fs.writeFileSync(path.join(outputRoot, 'contract.json'), `${JSON.stringify(generated.data, null, 2)}\n`);
  fs.writeFileSync(
    path.join(outputRoot, 'contract.md'),
    renderContract({ label: 'Farmed features · explicit unroll' }, generated),
  );
  fs.writeFileSync(path.join(outputRoot, 'run.json'), `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    model: generated.model,
    sourceEvidence: 'features/evidence.json',
    evidenceChars: JSON.stringify(evidence).length,
    promptTokens: generated.usageMetadata?.promptTokenCount || null,
    endpointClaims: generated.data.endpoints.length,
    responseId: generated.responseId,
    diagnosticOnly: true,
    promptDiffersFromCanonicalMatrix: true,
  }, null, 2)}\n`);
  console.log(`features-unrolled: ${generated.data.endpoints.length} endpoint claims`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
