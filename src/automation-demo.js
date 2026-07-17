'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { generateJsonWithFallback } = require('./gemini');

const AUTOMATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['assessment', 'automations'],
  properties: {
    assessment: {
      type: 'object',
      additionalProperties: false,
      required: ['summary', 'usefulEvidence', 'missingEvidence'],
      properties: {
        summary: { type: 'string' },
        usefulEvidence: { type: 'array', items: { type: 'string' }, minItems: 1 },
        missingEvidence: { type: 'array', items: { type: 'string' } },
      },
    },
    automations: {
      type: 'array',
      minItems: 3,
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'description', 'evidenceUsed', 'code'],
        properties: {
          name: { type: 'string', pattern: '^[a-z][a-z0-9-]{2,50}$' },
          description: { type: 'string' },
          evidenceUsed: { type: 'array', items: { type: 'string' }, minItems: 1 },
          code: { type: 'string' },
        },
      },
    },
  },
};

function selectContext(crossSession) {
  const coreSignatures = new Set(
    crossSession.crossSessionEndpoints
      .filter((endpoint) => endpoint.classifications.includes('core'))
      .map((endpoint) => endpoint.signature),
  );
  return {
    collection: {
      sessionCount: crossSession.sessionCount,
      usableSessionCount: crossSession.usableSessionCount,
      iterationCount: crossSession.iterationCount,
      capturedRequestCount: crossSession.capturedRequestCount,
    },
    endpoints: crossSession.crossSessionEndpoints.filter((endpoint) => coreSignatures.has(endpoint.signature)),
    fields: crossSession.crossSessionFields.filter((field) => coreSignatures.has(field.endpoint)),
    relations: crossSession.crossSessionRelations.filter((relation) => (
      (coreSignatures.has(relation.sourceEndpoint) || coreSignatures.has(relation.targetEndpoint))
      && (
        relation.target.includes(':: request.')
        || relation.source.includes(':: request.')
        || relation.kind.includes('token')
        || relation.kind.includes('jwt')
      )
    )),
    schemas: crossSession.crossSessionSchemas.filter((schema) => coreSignatures.has(schema.endpoint)),
    workflow: crossSession.consensusWorkflow,
    patterns: crossSession.patternTotals,
    sessionQuality: crossSession.sessions,
  };
}

function buildPrompt(context) {
  return [
    'You are evaluating whether machine-farmed HTTP timeline features are rich enough to generate automation.',
    'You have no API documentation and must use only the evidence JSON below.',
    'Create exactly three small, read-only Node.js 20+ node:test automation files using built-in fetch and node:assert/strict.',
    'The tests must target only https://api.artic.edu, make at most 3 HTTP requests per file, and never write data remotely.',
    'Use concrete endpoint paths, methods, payload/query structures, response schemas, constants, and response-to-request relations from the evidence.',
    'At least one automation must follow a value produced by one response into a later request.',
    'Use an AIC-User-Agent header with value "features-farming-gemini-demo (local evaluation)".',
    'Each code string must be a complete CommonJS test file. Do not use packages other than Node built-ins.',
    'Do not use environment variables, filesystem, child processes, eval, dynamic imports, proxies, or any host except api.artic.edu.',
    'Explain which exact farmed facts were useful and what remains missing.',
    '',
    'FARMED EVIDENCE JSON:',
    JSON.stringify(context, null, 2),
  ].join('\n');
}

function validateGeneratedCode(code) {
  const forbidden = [
    /\bchild_process\b/i,
    /\b(?:fs|net|tls|dgram|worker_threads)\b/,
    /\bprocess\s*\.\s*env\b/,
    /\beval\s*\(/,
    /\bnew\s+Function\b/,
    /\bimport\s*\(/,
    /\bexec(?:File|Sync)?\s*\(/,
    /\bspawn(?:Sync)?\s*\(/,
    /https?:\/\/(?!api\.artic\.edu\b)/i,
  ];
  const violation = forbidden.find((pattern) => pattern.test(code));
  if (violation) throw new Error(`Generated code rejected by safety policy: ${violation}`);
  if (!/node:test/.test(code) || !/node:assert\/strict/.test(code)) {
    throw new Error('Generated code must use node:test and node:assert/strict');
  }
  if (!/api\.artic\.edu/.test(code)) throw new Error('Generated code does not target api.artic.edu');
}

async function generateAutomationDemo({ apiKeys, farmDirectory, outputDirectory }) {
  const crossSessionFile = path.join(farmDirectory, 'cross-session.json');
  if (!fs.existsSync(crossSessionFile)) throw new Error(`Missing farmed collection: ${crossSessionFile}`);
  const crossSession = JSON.parse(fs.readFileSync(crossSessionFile, 'utf8'));
  const context = selectContext(crossSession);
  const generated = await generateJsonWithFallback({
    apiKeys,
    prompt: buildPrompt(context),
    responseJsonSchema: AUTOMATION_SCHEMA,
  });
  fs.mkdirSync(outputDirectory, { recursive: true });
  const files = [];
  for (const automation of generated.data.automations) {
    validateGeneratedCode(automation.code);
    const file = path.join(outputDirectory, `${automation.name}.test.js`);
    fs.writeFileSync(file, `${automation.code.trim()}\n`);
    files.push(file);
  }
  fs.writeFileSync(path.join(outputDirectory, 'gemini-result.json'), `${JSON.stringify({
    model: generated.model,
    keyIndex: generated.keyIndex,
    usageMetadata: generated.usageMetadata,
    assessment: generated.data.assessment,
    automations: generated.data.automations.map(({ code, ...automation }) => automation),
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(outputDirectory, 'prompt-context.json'), `${JSON.stringify(context, null, 2)}\n`);
  return { ...generated, files, context };
}

module.exports = {
  AUTOMATION_SCHEMA,
  buildPrompt,
  generateAutomationDemo,
  selectContext,
  validateGeneratedCode,
};
