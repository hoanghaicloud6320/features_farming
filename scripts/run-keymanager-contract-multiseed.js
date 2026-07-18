#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  CONDITIONS,
} = require('../src/gym-ab');
const {
  generateJsonWithFallback,
  loadApiKeys,
} = require('../src/gemini');
const {
  CONTRACT_SCHEMA,
  buildPrompt,
  evaluateContract,
} = require('./run-keymanager-contract-ab');

const DEFAULT_SEEDS = [95_501, 95_503, 95_507, 95_509, 95_521];
const ARM_IDS = ['raw', 'features', 'raw-features'];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function round(value, digits = 3) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function contentHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

function parseSeeds(value) {
  const seeds = value
    ? value.split(',').map((item) => Number(item.trim()))
    : DEFAULT_SEEDS;
  if (
    seeds.length < 3
    || seeds.length > 20
    || seeds.some((seed) => !Number.isFinite(seed) || !Number.isInteger(seed))
  ) {
    throw new Error('KEYMANAGER_SEEDS must contain 3 to 20 comma-separated integer seeds');
  }
  if (new Set(seeds).size !== seeds.length) throw new Error('KEYMANAGER_SEEDS must be unique');
  return seeds;
}

function behavioralChecks(contract) {
  const authenticationText = JSON.stringify(contract.authentication).toLowerCase();
  const workflowText = JSON.stringify(contract.workflows).toLowerCase();
  return {
    cookieAuthentication: authenticationText.includes('cookie'),
    namedAdminCookie: authenticationText.includes('km_admin'),
    createToPatchDependency: (
      workflowText.includes('post /v1/admin/licenses')
      && workflowText.includes('patch /v1/admin/licenses')
      && /(?:license\.)?id/.test(workflowText)
    ),
    createOrPatchToDeleteDependency: (
      workflowText.includes('delete /v1/admin/licenses')
      && /(?:license\.)?id/.test(workflowText)
    ),
  };
}

function aggregateArm(armId, runs) {
  const coverage = runs.map((run) => run.evaluation.endpointCoverage);
  const statuses = runs.map((run) => run.evaluation.exactStatusSetAccuracy);
  const tokens = runs.map((run) => run.promptTokens).filter(Number.isFinite);
  const rate = (selector) => round(runs.filter(selector).length / Math.max(runs.length, 1));
  return {
    arm: armId,
    runs: runs.length,
    endpointCoverage: {
      min: Math.min(...coverage),
      mean: round(mean(coverage)),
      perfectRunRate: rate((run) => run.evaluation.endpointCoverage === 1),
    },
    exactStatusSetAccuracy: {
      min: Math.min(...statuses),
      mean: round(mean(statuses)),
      perfectRunRate: rate((run) => run.evaluation.exactStatusSetAccuracy === 1),
    },
    noHallucinationRate: rate((run) => run.evaluation.hallucinatedEndpoints.length === 0),
    cookieAuthenticationRate: rate((run) => run.behavior.cookieAuthentication),
    namedAdminCookieRate: rate((run) => run.behavior.namedAdminCookie),
    createToPatchDependencyRate: rate((run) => run.behavior.createToPatchDependency),
    createOrPatchToDeleteDependencyRate: rate((run) => run.behavior.createOrPatchToDeleteDependency),
    promptTokens: {
      min: tokens.length ? Math.min(...tokens) : null,
      mean: tokens.length ? round(mean(tokens), 1) : null,
      max: tokens.length ? Math.max(...tokens) : null,
    },
    distinctContractCount: new Set(runs.map((run) => run.contractHash).filter(Boolean)).size,
  };
}

async function main() {
  const workspace = path.resolve(__dirname, '..');
  const sourceRoot = process.env.KEYMANAGER_MULTI_SEED_SOURCE
    ? path.resolve(process.env.KEYMANAGER_MULTI_SEED_SOURCE)
    : path.join(workspace, 'generated', 'keymanager-contract-ab-attention-v2');
  const outputRoot = process.env.KEYMANAGER_MULTI_SEED_OUTPUT
    ? path.resolve(process.env.KEYMANAGER_MULTI_SEED_OUTPUT)
    : path.join(workspace, 'generated', 'keymanager-contract-multiseed');
  const seeds = parseSeeds(process.env.KEYMANAGER_SEEDS);
  const conditions = new Map(CONDITIONS.map((condition) => [condition.id, condition]));
  const evidenceByArm = new Map(ARM_IDS.map((armId) => {
    const file = path.join(sourceRoot, armId, 'evidence.json');
    if (!fs.existsSync(file)) throw new Error(`Missing source evidence: ${file}`);
    return [armId, readJson(file)];
  }));
  const contractInventory = evidenceByArm.get('features').farmedFeatures?.contractInventory;
  if (!contractInventory?.length) {
    throw new Error('Source features evidence does not contain contractInventory; rerun keymanager:contract-ab with the current farmer');
  }

  const apiKeys = loadApiKeys(path.join(workspace, 'gemini-api-key.txt'));
  const result = {
    schemaVersion: 1,
    benchmark: 'keymanager-contract-multiseed',
    generatedAt: new Date().toISOString(),
    sourceRoot,
    seeds,
    arms: ARM_IDS,
    runs: [],
    aggregates: [],
  };
  fs.mkdirSync(outputRoot, { recursive: true });
  for (const seed of seeds) {
    for (const armId of ARM_IDS) {
      const condition = conditions.get(armId);
      const evidence = evidenceByArm.get(armId);
      const generated = await generateJsonWithFallback({
        apiKeys,
        prompt: buildPrompt(condition, evidence),
        responseJsonSchema: CONTRACT_SCHEMA,
        maxOutputTokens: 12_000,
        seed,
      });
      const evaluation = evaluateContract(generated.data, contractInventory);
      const behavior = behavioralChecks(generated.data);
      const run = {
        seed,
        arm: armId,
        model: generated.model,
        responseId: generated.responseId,
        promptTokens: generated.usageMetadata?.promptTokenCount || null,
        contractHash: contentHash(generated.data),
        evaluation,
        behavior,
      };
      result.runs.push(run);
      const runRoot = path.join(outputRoot, `seed-${seed}`, armId);
      fs.mkdirSync(runRoot, { recursive: true });
      fs.writeFileSync(path.join(runRoot, 'contract.json'), `${JSON.stringify(generated.data, null, 2)}\n`);
      fs.writeFileSync(path.join(runRoot, 'run.json'), `${JSON.stringify(run, null, 2)}\n`);
      console.log(
        `seed ${seed} ${armId}: coverage ${evaluation.matchedEndpoints}/${evaluation.expectedEndpoints}, `
        + `statuses ${evaluation.exactStatusSets}/${evaluation.expectedEndpoints}`,
      );
    }
  }
  result.aggregates = ARM_IDS.map((armId) => (
    aggregateArm(armId, result.runs.filter((run) => run.arm === armId))
  ));
  fs.writeFileSync(path.join(outputRoot, 'matrix.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log('');
  for (const aggregate of result.aggregates) {
    console.log(
      `${aggregate.arm}: coverage perfect ${(aggregate.endpointCoverage.perfectRunRate * 100).toFixed(0)}%, `
      + `status perfect ${(aggregate.exactStatusSetAccuracy.perfectRunRate * 100).toFixed(0)}%, `
      + `mean tokens ${aggregate.promptTokens.mean}`,
    );
  }
  console.log(`Multi-seed matrix: ${path.join(outputRoot, 'matrix.json')}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  aggregateArm,
  behavioralChecks,
  parseSeeds,
};
