#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { runAbDemo } = require('../src/ab-demo');
const { loadApiKeys } = require('../src/gemini');

async function main() {
  const workspace = path.resolve(__dirname, '..');
  const apiKeys = loadApiKeys(path.resolve(workspace, 'gemini-api-key.txt'));
  const farmDirectory = path.join(workspace, 'output', 'demo', 'artic-artworks');
  const outputDirectory = path.join(workspace, 'generated', 'artic-ab');
  console.log(`Running controlled A/B with ${apiKeys.length} available key slot(s); key contents are not logged.`);
  const result = await runAbDemo({ apiKeys, farmDirectory, outputDirectory });
  const a = result.conditions.noFeatures;
  const b = result.conditions.withFeatures;
  console.log(`A no-features: ${a.execution.passCount}/3 live tests, rubric ${a.rubric.score}/${a.rubric.maximum}`);
  console.log(`B with-features: ${b.execution.passCount}/3 live tests, rubric ${b.rubric.score}/${b.rubric.maximum}`);
  console.log(`Report: ${path.join(outputDirectory, 'comparison.md')}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
