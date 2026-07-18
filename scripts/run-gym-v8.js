#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { generateV8Suite } = require('../gym/v8-cases');
const { writeV8Recording } = require('../gym/v8-recording');
const { farmInput } = require('../src/collection');
const { buildV8Result, evaluateV8Case, writeV8Result } = require('../src/gym-v8');

function configuration() {
  const seed = Number(process.env.GYM_V8_SEED || 88_001);
  const sessionsPerCase = Number(process.env.GYM_V8_SESSIONS || 2);
  const iterationsPerSession = Number(process.env.GYM_V8_ITERATIONS || 4);
  if (!Number.isInteger(seed)) throw new Error('GYM_V8_SEED must be an integer');
  if (!Number.isInteger(sessionsPerCase) || sessionsPerCase < 2 || sessionsPerCase > 4) {
    throw new Error('GYM_V8_SESSIONS must be an integer from 2 to 4');
  }
  if (!Number.isInteger(iterationsPerSession) || iterationsPerSession < 3 || iterationsPerSession > 8) {
    throw new Error('GYM_V8_ITERATIONS must be an integer from 3 to 8');
  }
  return { seed, sessionsPerCase, iterationsPerSession };
}

async function main() {
  const workspace = path.resolve(__dirname, '..');
  const settings = configuration();
  const runId = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const dataRoot = process.env.GYM_V8_DATA_ROOT
    ? path.resolve(process.env.GYM_V8_DATA_ROOT)
    : path.join(workspace, 'demo-data', 'gym-v8', runId);
  const farmRoot = process.env.GYM_V8_FARM_ROOT
    ? path.resolve(process.env.GYM_V8_FARM_ROOT)
    : path.join(workspace, 'output', 'gym-v8', runId);
  const resultRoot = process.env.GYM_V8_OUTPUT
    ? path.resolve(process.env.GYM_V8_OUTPUT)
    : path.join(workspace, 'generated', 'gym-ab-v8');
  const suite = generateV8Suite(settings.seed);
  const caseResults = [];
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(farmRoot, { recursive: true });

  for (let caseIndex = 0; caseIndex < suite.cases.length; caseIndex += 1) {
    const definition = suite.cases[caseIndex];
    const recordingRoot = path.join(dataRoot, definition.id);
    const caseFarmRoot = path.join(farmRoot, definition.id);
    for (
      let sessionNumber = 1;
      sessionNumber <= settings.sessionsPerCase;
      sessionNumber += 1
    ) {
      writeV8Recording({
        definition,
        directory: path.join(recordingRoot, `session-${sessionNumber}`),
        sessionNumber,
        iterationCount: settings.iterationsPerSession,
      });
    }
    const farmed = await farmInput({
      inputDirectory: recordingRoot,
      outputDirectory: caseFarmRoot,
    });
    caseResults.push(evaluateV8Case(definition, farmed));
    console.log(
      `[${caseIndex + 1}/${suite.cases.length}] ${definition.configuration} `
      + `case ${definition.caseNumber}: ${caseResults.at(-1).score}/100`,
    );
  }

  const result = buildV8Result(suite, caseResults, settings);
  writeV8Result(resultRoot, result);
  console.log('');
  console.log(
    `V8: ${result.aggregates.meanScore}/100, worst ${result.aggregates.worstScore}, `
    + `perfect ${(result.aggregates.perfectCaseRate * 100).toFixed(1)}%`,
  );
  console.log(`V8 report: ${path.join(resultRoot, 'matrix.md')}`);
  return result;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  configuration,
  main,
};
