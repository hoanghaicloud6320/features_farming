#!/usr/bin/env node
'use strict';

const { generateV7Suite } = require('../gym/v7-cases');
const { runGym } = require('./run-gym-v6');

const DEFAULT_V7_SEEDS = [81_017, 81_037, 81_061, 81_083, 81_101];

async function main() {
  return runGym({
    benchmark: 'farmer-gym-v7',
    defaultSeeds: DEFAULT_V7_SEEDS,
    environmentPrefix: 'GYM_V7',
    folder: 'gym-v7',
    resultFolder: 'gym-ab-v7',
    suiteFactory: generateV7Suite,
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_V7_SEEDS,
  main,
};
