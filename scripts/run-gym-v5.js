#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { NetworkRecorder } = require('../../requests_recorder/src/recorder');
const { V5_CASES, V5_CASE_BY_ID } = require('../gym/v5-cases');
const { createGymServer } = require('../gym/server');
const { farmInput } = require('../src/collection');
const { buildV5Result, writeV5Result } = require('../src/gym-v5');

const SESSION_COUNT = Number(process.env.GYM_V5_SESSIONS || 3);
const ITERATIONS_PER_SESSION = Number(process.env.GYM_V5_ITERATIONS || 5);

function selectedCases() {
  if (!process.env.GYM_V5_CASES) return V5_CASES;
  return process.env.GYM_V5_CASES.split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((id) => {
      const definition = V5_CASE_BY_ID.get(id);
      if (!definition) throw new Error(`Unknown Gym V5 case: ${id}`);
      return definition;
    });
}

async function waitForIterationEnd(recorder, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (recorder.iterationState().active && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  if (recorder.iterationState().active) await recorder.endIteration('gym-v5-collector-timeout');
}

async function collectSession({
  origin,
  outputRoot,
  definition,
  sessionNumber,
}) {
  const recorder = new NetworkRecorder({
    outputRoot,
    startUrl: origin,
    headless: true,
    showControls: false,
    captureBodies: true,
    maxBodyBytes: 1024 * 1024,
    iterationQuietMs: 180,
    iterationMinMs: 0,
    iterationMaxMs: 12_000,
  });
  try {
    const { page } = await recorder.start();
    await page.waitForFunction(() => Boolean(window.Gym));
    for (let index = 0; index < ITERATIONS_PER_SESSION; index += 1) {
      const label = `${definition.id}-s${sessionNumber}-sample-${index + 1}`;
      await recorder.startIteration(`gym-v5-${definition.id}`);
      const result = await page.evaluate(
        ({ caseId, sampleLabel, sequence }) => (
          window.Gym.runChallenge(caseId, sampleLabel, sequence)
        ),
        {
          caseId: definition.id,
          sampleLabel: label,
          sequence: (sessionNumber * 100) + index,
        },
      );
      if (!result.accepted) throw new Error(`${definition.id} iteration was not accepted`);
      await waitForIterationEnd(recorder);
    }
    return await recorder.stop(`gym-v5-${definition.id}-complete`);
  } catch (error) {
    await recorder.stop(`gym-v5-${definition.id}-error`);
    throw error;
  }
}

function validateConfiguration() {
  if (!Number.isInteger(SESSION_COUNT) || SESSION_COUNT < 2 || SESSION_COUNT > 10) {
    throw new Error('GYM_V5_SESSIONS must be an integer from 2 to 10');
  }
  if (!Number.isInteger(ITERATIONS_PER_SESSION) || ITERATIONS_PER_SESSION < 3 || ITERATIONS_PER_SESSION > 20) {
    throw new Error('GYM_V5_ITERATIONS must be an integer from 3 to 20');
  }
}

async function main() {
  validateConfiguration();
  const workspace = path.resolve(__dirname, '..');
  const runId = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const dataRoot = process.env.GYM_V5_DATA_ROOT
    ? path.resolve(process.env.GYM_V5_DATA_ROOT)
    : path.join(workspace, 'demo-data', 'gym-v5', runId);
  const farmRoot = process.env.GYM_V5_FARM_ROOT
    ? path.resolve(process.env.GYM_V5_FARM_ROOT)
    : path.join(workspace, 'output', 'gym-v5', runId);
  const resultRoot = process.env.GYM_V5_OUTPUT
    ? path.resolve(process.env.GYM_V5_OUTPUT)
    : path.join(workspace, 'generated', 'gym-ab-v5');
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(farmRoot, { recursive: true });

  const gym = createGymServer();
  const origin = await gym.listen();
  const cases = selectedCases();
  const caseOutputs = new Map();
  const manifest = {
    schemaVersion: 1,
    benchmark: 'farmer-gym-v5',
    generatedAt: new Date().toISOString(),
    origin,
    sessionsPerCase: SESSION_COUNT,
    iterationsPerSession: ITERATIONS_PER_SESSION,
    dataRoot,
    farmRoot,
    resultRoot,
    cases: [],
  };
  try {
    for (let caseIndex = 0; caseIndex < cases.length; caseIndex += 1) {
      const definition = cases[caseIndex];
      const recordingRoot = path.join(dataRoot, definition.id);
      const caseFarmRoot = path.join(farmRoot, definition.id);
      fs.mkdirSync(recordingRoot, { recursive: true });
      const sessions = [];
      for (let sessionNumber = 1; sessionNumber <= SESSION_COUNT; sessionNumber += 1) {
        const directory = await collectSession({
          origin,
          outputRoot: recordingRoot,
          definition,
          sessionNumber,
        });
        sessions.push(directory);
        console.log(`[${caseIndex + 1}/${cases.length}] ${definition.id}: session ${sessionNumber}/${SESSION_COUNT} captured`);
      }
      const farmed = await farmInput({
        inputDirectory: recordingRoot,
        outputDirectory: caseFarmRoot,
      });
      const firstSession = farmed.sessionResults[0].result;
      caseOutputs.set(definition.id, {
        single: firstSession,
        crossSession: farmed.summary,
      });
      manifest.cases.push({
        id: definition.id,
        axis: definition.axis.id,
        recordings: recordingRoot,
        farm: caseFarmRoot,
        capturedRequestCount: farmed.summary.capturedRequestCount,
        relationCount: farmed.summary.crossSessionRelations.length,
      });
      console.log(`[${caseIndex + 1}/${cases.length}] ${definition.id}: farmer output ready`);
    }
  } finally {
    await gym.close();
  }

  if (cases.length !== V5_CASES.length) {
    throw new Error('A partial GYM_V5_CASES run cannot produce the canonical V5 matrix');
  }
  const result = buildV5Result(caseOutputs);
  result.run = {
    sessionsPerCase: SESSION_COUNT,
    iterationsPerSession: ITERATIONS_PER_SESSION,
  };
  writeV5Result(resultRoot, result);
  fs.writeFileSync(path.join(resultRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log('');
  for (const aggregate of result.aggregates) {
    console.log(`${aggregate.arm}: ${aggregate.meanScore}/100, relation F1 ${aggregate.meanRelationF1}`);
  }
  console.log(`V5 report: ${path.join(resultRoot, 'matrix.md')}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
