#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { generateV6Suite } = require('../gym/v6-cases');
const { writeV6Recording } = require('../gym/v6-recording');
const { farmInput } = require('../src/collection');
const { buildV6Result, writeV6Result } = require('../src/gym-v6');

const DEFAULT_SEEDS = [73_001, 73_019, 73_043];
const SESSION_COUNT = Number(process.env.GYM_V6_SESSIONS || 2);
const ITERATIONS_PER_SESSION = Number(process.env.GYM_V6_ITERATIONS || 4);

function parseSeedList(value, defaultSeeds, environmentName) {
  const seeds = value
    ? value.split(',').map((item) => Number(item.trim()))
    : defaultSeeds;
  if (
    seeds.length < 2
    || seeds.length > 10
    || seeds.some((seed) => !Number.isFinite(seed) || !Number.isInteger(seed))
  ) {
    throw new Error(`${environmentName} must contain 2 to 10 comma-separated integer seeds`);
  }
  if (new Set(seeds).size !== seeds.length) throw new Error(`${environmentName} must be unique`);
  return seeds;
}

function parseSeeds(value) {
  return parseSeedList(value, DEFAULT_SEEDS, 'GYM_V6_SEEDS');
}

function validateConfiguration(
  sessionCount = SESSION_COUNT,
  iterationsPerSession = ITERATIONS_PER_SESSION,
  environmentPrefix = 'GYM_V6',
) {
  if (!Number.isInteger(sessionCount) || sessionCount < 2 || sessionCount > 5) {
    throw new Error(`${environmentPrefix}_SESSIONS must be an integer from 2 to 5`);
  }
  if (!Number.isInteger(iterationsPerSession) || iterationsPerSession < 3 || iterationsPerSession > 10) {
    throw new Error(`${environmentPrefix}_ITERATIONS must be an integer from 3 to 10`);
  }
}

async function runGym({
  benchmark = 'farmer-gym-v6',
  defaultSeeds = DEFAULT_SEEDS,
  environmentPrefix = 'GYM_V6',
  folder = 'gym-v6',
  resultFolder = 'gym-ab-v6',
  suiteFactory = generateV6Suite,
} = {}) {
  const sessionCount = Number(process.env[`${environmentPrefix}_SESSIONS`] || 2);
  const iterationsPerSession = Number(process.env[`${environmentPrefix}_ITERATIONS`] || 4);
  validateConfiguration(sessionCount, iterationsPerSession, environmentPrefix);
  const workspace = path.resolve(__dirname, '..');
  const runId = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const dataRootVariable = `${environmentPrefix}_DATA_ROOT`;
  const farmRootVariable = `${environmentPrefix}_FARM_ROOT`;
  const outputVariable = `${environmentPrefix}_OUTPUT`;
  const seedsVariable = `${environmentPrefix}_SEEDS`;
  const dataRoot = process.env[dataRootVariable]
    ? path.resolve(process.env[dataRootVariable])
    : path.join(workspace, 'demo-data', folder, runId);
  const farmRoot = process.env[farmRootVariable]
    ? path.resolve(process.env[farmRootVariable])
    : path.join(workspace, 'output', folder, runId);
  const resultRoot = process.env[outputVariable]
    ? path.resolve(process.env[outputVariable])
    : path.join(workspace, 'generated', resultFolder);
  const seeds = parseSeedList(process.env[seedsVariable], defaultSeeds, seedsVariable);
  const suites = seeds.map(suiteFactory);
  const caseOutputs = new Map();
  const manifest = {
    schemaVersion: 1,
    benchmark,
    generatedAt: new Date().toISOString(),
    seeds,
    sessionsPerCase: sessionCount,
    iterationsPerSession,
    cases: [],
  };
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(farmRoot, { recursive: true });

  let completed = 0;
  const total = suites.reduce((sum, suite) => sum + suite.cases.length, 0);
  for (const suite of suites) {
    for (const definition of suite.cases) {
      const recordingRoot = path.join(dataRoot, `seed-${suite.seed}`, definition.id);
      const caseFarmRoot = path.join(farmRoot, `seed-${suite.seed}`, definition.id);
      for (let sessionNumber = 1; sessionNumber <= sessionCount; sessionNumber += 1) {
        writeV6Recording({
          definition,
          directory: path.join(recordingRoot, `session-${sessionNumber}`),
          sessionNumber,
          iterationCount: iterationsPerSession,
        });
      }
      const farmed = await farmInput({
        inputDirectory: recordingRoot,
        outputDirectory: caseFarmRoot,
      });
      caseOutputs.set(definition.id, {
        single: farmed.sessionResults[0].result,
        crossSession: farmed.summary,
      });
      completed += 1;
      manifest.cases.push({
        id: definition.id,
        seed: suite.seed,
        family: definition.family,
        recordingRoot,
        farmRoot: caseFarmRoot,
        capturedRequestCount: farmed.summary.capturedRequestCount,
        familyRelationCount: farmed.summary.crossSessionRelations.length,
        concreteRelationCount: farmed.summary.crossSessionMemberRelations.length,
      });
      console.log(`[${completed}/${total}] seed ${suite.seed} ${definition.family}: farmer output ready`);
    }
  }

  const result = buildV6Result(suites, caseOutputs, {
    benchmark,
    sessionsPerCase: sessionCount,
    iterationsPerSession,
  });
  writeV6Result(resultRoot, result);
  fs.writeFileSync(path.join(resultRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log('');
  for (const aggregate of result.aggregates) {
    console.log(
      `${aggregate.arm}: ${aggregate.meanScore}/100, worst ${aggregate.worstCaseScore}, `
      + `relation recall ${(aggregate.relationRecall * 100).toFixed(1)}%`,
    );
  }
  console.log(`${benchmark} report: ${path.join(resultRoot, 'matrix.md')}`);
  return result;
}

async function main() {
  return runGym();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  parseSeedList,
  parseSeeds,
  runGym,
  validateConfiguration,
};
