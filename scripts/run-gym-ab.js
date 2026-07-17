#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { createGymServer } = require('../gym/server');
const { loadApiKeys } = require('../src/gemini');
const { runGymMatrix } = require('../src/gym-ab');

async function main() {
  const workspace = path.resolve(__dirname, '..');
  const apiKeyFile = process.env.GEMINI_API_KEY_FILE
    ? path.resolve(process.env.GEMINI_API_KEY_FILE)
    : path.resolve(workspace, '..', 'requests_recorder', 'gemini-api-key.txt');
  const apiKeys = loadApiKeys(apiKeyFile);
  const challengeIds = process.env.GYM_CHALLENGES
    ? process.env.GYM_CHALLENGES.split(',').map((value) => value.trim()).filter(Boolean)
    : undefined;
  const trials = Number(process.env.GYM_TRIALS || 1);
  const contextBudgetChars = process.env.GYM_CONTEXT_BUDGET_CHARS
    ? Number(process.env.GYM_CONTEXT_BUDGET_CHARS)
    : Infinity;
  if (!Number.isInteger(trials) || trials < 1 || trials > 20) {
    throw new Error('GYM_TRIALS must be an integer from 1 to 20');
  }
  if (!(contextBudgetChars > 1000)) {
    throw new Error('GYM_CONTEXT_BUDGET_CHARS must be greater than 1000');
  }
  const gym = createGymServer();
  const origin = await gym.listen();
  try {
    const result = await runGymMatrix({
      apiKeys,
      origin,
      gym,
      recordingRoot: path.join(workspace, 'demo-data', 'gym'),
      farmRoot: path.join(workspace, 'output', 'gym'),
      outputRoot: process.env.GYM_AB_OUTPUT
        ? path.resolve(process.env.GYM_AB_OUTPUT)
        : path.join(workspace, 'generated', 'gym-ab'),
      challengeIds,
      trials,
      contextBudgetChars,
    });
    console.log('');
    for (const aggregate of result.aggregates) {
      console.log(`${aggregate.label}: ${aggregate.accepted}/${aggregate.total} accepted, mean ${aggregate.meanScore}/10`);
    }
  } finally {
    await gym.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
