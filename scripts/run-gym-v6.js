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

function parseSeeds(value) {
  const seeds = value
    ? value.split(',').map((item) => Number(item.trim()))
    : DEFAULT_SEEDS;
  if (
    seeds.length < 2
    || seeds.length > 10
    || seeds.some((seed) => !Number.isFinite(seed) || !Number.isInteger(seed))
  ) {
    throw new Error('GYM_V6_SEEDS must contain 2 to 10 comma-separated integer seeds');
  }
  if (new Set(seeds).size !== seeds.length) throw new Error('GYM_V6_SEEDS must be unique');
  return seeds;
}

function validateConfiguration() {
  if (!Number.isInteger(SESSION_COUNT) || SESSION_COUNT < 2 || SESSION_COUNT > 5) {
    throw new Error('GYM_V6_SESSIONS must be an integer from 2 to 5');
  }
  if (!Number.isInteger(ITERATIONS_PER_SESSION) || ITERATIONS_PER_SESSION < 3 || ITERATIONS_PER_SESSION > 10) {
    throw new Error('GYM_V6_ITERATIONS must be an integer from 3 to 10');
  }
}

async function main() {
  validateConfiguration();
  const workspace = path.resolve(__dirname, '..');
  const runId = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const dataRoot = process.env.GYM_V6_DATA_ROOT
    ? path.resolve(process.env.GYM_V6_DATA_ROOT)
    : path.join(workspace, 'demo-data', 'gym-v6', runId);
  const farmRoot = process.env.GYM_V6_FARM_ROOT
    ? path.resolve(process.env.GYM_V6_FARM_ROOT)
    : path.join(workspace, 'output', 'gym-v6', runId);
  const resultRoot = process.env.GYM_V6_OUTPUT
    ? path.resolve(process.env.GYM_V6_OUTPUT)
    : path.join(workspace, 'generated', 'gym-ab-v6');
  const seeds = parseSeeds(process.env.GYM_V6_SEEDS);
  const suites = seeds.map(generateV6Suite);
  const caseOutputs = new Map();
  const manifest = {
    schemaVersion: 1,
    benchmark: 'farmer-gym-v6',
    generatedAt: new Date().toISOString(),
    seeds,
    sessionsPerCase: SESSION_COUNT,
    iterationsPerSession: ITERATIONS_PER_SESSION,
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
      for (let sessionNumber = 1; sessionNumber <= SESSION_COUNT; sessionNumber += 1) {
        writeV6Recording({
          definition,
          directory: path.join(recordingRoot, `session-${sessionNumber}`),
          sessionNumber,
          iterationCount: ITERATIONS_PER_SESSION,
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
    sessionsPerCase: SESSION_COUNT,
    iterationsPerSession: ITERATIONS_PER_SESSION,
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
  console.log(`V6 report: ${path.join(resultRoot, 'matrix.md')}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  parseSeeds,
  validateConfiguration,
};
