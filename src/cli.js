#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { farmInput } = require('./collection');

function usage() {
  return [
    'Usage:',
    '  npm run farm -- --input <recording-directory> [--output <directory>]',
    '',
    'Options:',
    '  --input <directory>   One recording, or a parent containing multiple recordings',
    '  --output <directory>  Destination (default: <input>/features)',
    '  --max-json-mb <n>     Maximum JSON response body to inspect (default: 5)',
    '  --help                 Show this help',
  ].join('\n');
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--input') options.input = argv[++index];
    else if (argument === '--output') options.output = argv[++index];
    else if (argument === '--max-json-mb') options.maxJsonMb = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.input) throw new Error('--input is required');
  if (options.maxJsonMb !== undefined && (!Number.isFinite(options.maxJsonMb) || options.maxJsonMb <= 0)) {
    throw new Error('--max-json-mb must be a positive number');
  }

  const inputDirectory = path.resolve(options.input);
  const outputDirectory = path.resolve(options.output || path.join(inputDirectory, 'features'));
  const farmed = await farmInput({
    inputDirectory,
    outputDirectory,
    maxJsonBytes: Math.round((options.maxJsonMb || 5) * 1024 * 1024),
  });
  if (farmed.mode === 'recording') {
    const result = farmed.result;
    console.log(`Farmed ${result.summary.recording.capturedRequestCount} captured requests.`);
    console.log(`Found ${result.summary.endpoints.coreCount} core endpoints, ${result.summary.variables.length} variable fields and ${result.summary.relations.length} supported relations.`);
  } else {
    console.log(`Farmed ${farmed.summary.sessionCount} sessions with ${farmed.summary.iterationCount} usable iterations.`);
    console.log(`Found ${farmed.summary.crossSessionEndpoints.length} cross-session endpoints and ${farmed.summary.crossSessionRelations.length} repeated relations.`);
  }
  console.log(`Report: ${path.join(outputDirectory, 'report.md')}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
