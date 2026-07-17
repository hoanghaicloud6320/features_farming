#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { generateAutomationDemo } = require('../src/automation-demo');
const { loadApiKeys } = require('../src/gemini');

async function main() {
  const workspace = path.resolve(__dirname, '..');
  const keyFile = path.resolve(workspace, 'gemini-api-key.txt');
  const farmDirectory = path.join(workspace, 'output', 'demo', 'artic-artworks');
  const outputDirectory = path.join(workspace, 'generated', 'artic-artworks');
  const apiKeys = loadApiKeys(keyFile);
  console.log(`Loaded ${apiKeys.length} Gemini key(s); key contents will not be logged.`);
  const result = await generateAutomationDemo({ apiKeys, farmDirectory, outputDirectory });
  console.log(`Gemini model: ${result.model}; successful key slot: #${result.keyIndex + 1}`);
  console.log(`Generated ${result.files.length} validated automation files in ${outputDirectory}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
