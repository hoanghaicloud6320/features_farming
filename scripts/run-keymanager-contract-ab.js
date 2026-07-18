#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { NetworkRecorder } = require('../../requests_recorder/src/recorder');
const { farmInput } = require('../src/collection');
const {
  CONDITIONS,
  buildBudgetedEvidence,
  buildFeatureContext,
  buildRawContext,
} = require('../src/gym-ab');
const { generateJsonWithFallback, loadApiKeys } = require('../src/gemini');

const TARGET = 'https://keymanager-cloud.thuanvatlyhy.workers.dev/admin';
const ADMIN_NAME = process.env.KEYMANAGER_ADMIN_NAME || '';
const SESSION_COUNT = Number(process.env.KEYMANAGER_SESSIONS || 3);
const ITERATIONS_PER_SESSION = Number(process.env.KEYMANAGER_ITERATIONS || 3);
const CONTEXT_BUDGET_CHARS = Number(process.env.KEYMANAGER_CONTEXT_BUDGET_CHARS || 32_000);
const GENERATION_SEED = Number(process.env.KEYMANAGER_SEED || 95_501);

const CONTRACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'summary', 'authentication', 'endpoints', 'workflows', 'uncertainties', 'nodejsSample'],
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    authentication: {
      type: 'object',
      additionalProperties: false,
      required: ['mechanism', 'evidence', 'uncertainties'],
      properties: {
        mechanism: { type: 'string' },
        evidence: { type: 'array', items: { type: 'string' } },
        uncertainties: { type: 'array', items: { type: 'string' } },
      },
    },
    endpoints: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'method', 'path', 'purpose', 'request', 'response',
          'observedStatuses', 'confidence', 'evidence', 'warnings',
        ],
        properties: {
          method: { type: 'string' },
          path: { type: 'string' },
          purpose: { type: 'string' },
          request: { type: 'string' },
          response: { type: 'string' },
          observedStatuses: { type: 'array', items: { type: 'integer' } },
          confidence: { type: 'string', enum: ['observed', 'inferred', 'unknown'] },
          evidence: { type: 'array', items: { type: 'string' } },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    workflows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'steps', 'dataFlow', 'confidence'],
        properties: {
          name: { type: 'string' },
          steps: { type: 'array', items: { type: 'string' } },
          dataFlow: { type: 'array', items: { type: 'string' } },
          confidence: { type: 'string', enum: ['observed', 'inferred', 'unknown'] },
        },
      },
    },
    uncertainties: { type: 'array', items: { type: 'string' } },
    nodejsSample: { type: 'string' },
  },
};

function timestampId() {
  return new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
}

function shortHash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

function round(value, digits = 3) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function redact(value, key = '') {
  if (Array.isArray(value)) return value.map((item) => redact(item, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => (
      [childKey, redact(child, childKey)]
    )));
  }
  if (
    value !== null
    && /authorization|cookie|token|secret|password|license.?key|session.?key/i.test(key)
  ) {
    return { redacted: true, valueHash: shortHash(value), length: String(value).length };
  }
  return value;
}

function sanitizeRaw(raw) {
  return redact(raw);
}

function localDateTime(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    '-',
    pad(date.getMonth() + 1),
    '-',
    pad(date.getDate()),
    'T',
    pad(date.getHours()),
    ':',
    pad(date.getMinutes()),
  ].join('');
}

async function login(page) {
  const input = page.getByRole('textbox', { name: 'Tên truy cập' });
  await input.fill(ADMIN_NAME);
  await page.getByRole('button', { name: 'Vào dashboard' }).click();
  await page.getByRole('heading', { name: 'Licenses' }).waitFor();
}

async function createLicense(page, key, label, iteration) {
  await page.getByRole('button', { name: '+ Tạo license' }).click();
  const dialog = page.getByRole('dialog');
  const now = new Date();
  const expires = new Date(now.getTime() + (14 + iteration) * 24 * 60 * 60 * 1000);
  await dialog.getByRole('textbox', { name: 'License key Generate' }).fill(key);
  await dialog.getByRole('textbox', { name: 'Tên người đăng ký' }).fill(label);
  await dialog.getByRole('textbox', { name: 'Sản phẩm' }).fill(`contract-probe-${iteration}`);
  await dialog.getByRole('textbox', { name: 'Bắt đầu' }).fill(localDateTime(now));
  await dialog.getByRole('textbox', { name: 'Hết hạn' }).fill(localDateTime(expires));
  await dialog.getByRole('spinbutton', { name: 'Giới hạn tổng login' }).fill(String(10 + iteration));
  await dialog.getByRole('spinbutton', { name: 'Phiên đồng thời tối đa' }).fill(String(2 + iteration));
  await dialog.getByRole('textbox', { name: 'Metadata JSON' }).fill(JSON.stringify({
    benchmark: 'features-farming',
    iteration,
  }));
  await dialog.getByRole('button', { name: 'Lưu license' }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.getByRole('row').filter({ hasText: key }).waitFor();
}

async function updateLicense(page, key, label) {
  const row = page.getByRole('row').filter({ hasText: key });
  await row.getByRole('button', { name: 'Sửa' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Tên người đăng ký' }).fill(`${label}-updated`);
  await dialog.getByRole('combobox', { name: 'Trạng thái' }).selectOption('revoked');
  await dialog.getByRole('button', { name: 'Lưu license' }).click();
  await dialog.waitFor({ state: 'hidden' });
}

async function deleteLicense(page, key) {
  const row = page.getByRole('row').filter({ hasText: key });
  await row.getByRole('button', { name: 'Sửa' }).click();
  const dialog = page.getByRole('dialog');
  page.once('dialog', (browserDialog) => browserDialog.accept());
  await dialog.getByRole('button', { name: 'Xóa license' }).click();
  await dialog.waitFor({ state: 'hidden' });
}

async function exerciseIteration(page, recorder, sessionNumber, iteration) {
  await recorder.startIteration(`keymanager-contract-s${sessionNumber}`);
  try {
    await login(page);
    await page.getByRole('button', { name: 'Làm mới' }).click();
    const suffix = crypto.randomBytes(5).toString('hex').toUpperCase();
    const key = `KM-AB-${sessionNumber}${iteration}-${suffix}`;
    const label = `Contract Probe S${sessionNumber} I${iteration}`;
    await createLicense(page, key, label, iteration);
    await updateLicense(page, key, label);
    await page.getByRole('button', { name: '02 Audit log' }).click();
    await page.getByRole('heading', { name: 'Audit log' }).waitFor();
    await page.getByRole('button', { name: 'Làm mới' }).click();
    await page.getByRole('button', { name: '01 Licenses' }).click();
    await page.getByRole('heading', { name: 'Licenses' }).waitFor();
    await deleteLicense(page, key);
    await page.getByRole('button', { name: 'Đăng xuất' }).click();
    await page.getByRole('button', { name: 'Vào dashboard' }).waitFor();
  } finally {
    await recorder.endIteration('keymanager-contract-workflow-complete');
  }
}

async function collectSession(outputRoot, sessionNumber) {
  const recorder = new NetworkRecorder({
    outputRoot,
    startUrl: TARGET,
    headless: true,
    showControls: false,
    captureBodies: true,
    maxBodyBytes: 1024 * 1024,
    iterationQuietMs: 300,
    iterationMinMs: 60_000,
    iterationMaxMs: 90_000,
  });
  try {
    const { page } = await recorder.start();
    for (let iteration = 1; iteration <= ITERATIONS_PER_SESSION; iteration += 1) {
      await exerciseIteration(page, recorder, sessionNumber, iteration);
      console.log(`session ${sessionNumber}/${SESSION_COUNT}: iteration ${iteration}/${ITERATIONS_PER_SESSION}`);
    }
    return await recorder.stop('keymanager-contract-complete');
  } catch (error) {
    await recorder.stop('keymanager-contract-error');
    throw error;
  }
}

function buildPrompt(condition, evidence) {
  return [
    'You are producing an API contract from controlled browser-traffic evidence.',
    'Do not generate automation tests. A short Node.js fetch sample is optional.',
    'Do not invent endpoints, fields, statuses, authentication mechanisms, or semantics.',
    'Mark every endpoint as observed, inferred, or unknown.',
    'When evidence is absent, state that a reliable contract cannot be recovered.',
    'Describe request and response shapes compactly in plain text.',
    'When farmedFeatures.contractInventory exists, treat it as the authoritative concrete inventory and transcribe its pre-attributed status/schema evidence; do not rematch siblings yourself.',
    'contractInventory.dataFlows are already joined and ranked by the farmer. Describe those direct flows without searching other fields for matches.',
    'An omitted count means lower-ranked evidence was intentionally excluded; do not infer its contents.',
    'For every endpoint unrolled from a generalized :var family, use its concrete member index for statuses, query keys, request fields, response schemas, examples, and relations.',
    'Do not copy a family-level status, schema, field, or relation onto a concrete sibling; warn when the evidence marks an attribute as family-only.',
    'Keep redacted values redacted; never attempt to reconstruct secrets.',
    `Evidence condition: ${condition.label}`,
    '',
    'EVIDENCE JSON:',
    JSON.stringify(evidence, null, 2),
  ].join('\n');
}

function renderContract(condition, generated) {
  const contract = generated.data;
  const lines = [
    `# ${condition.label}: ${contract.title}`,
    '',
    contract.summary,
    '',
    '## Authentication',
    '',
    contract.authentication.mechanism,
  ];
  for (const item of contract.authentication.evidence) lines.push(`- ${item}`);
  for (const item of contract.authentication.uncertainties) lines.push(`- Uncertain: ${item}`);
  lines.push('', '## Endpoints', '');
  for (const endpoint of contract.endpoints) {
    lines.push(`### ${endpoint.method} ${endpoint.path}`, '');
    lines.push(`- Purpose: ${endpoint.purpose}`);
    lines.push(`- Request: ${endpoint.request}`);
    lines.push(`- Response: ${endpoint.response}`);
    lines.push(`- Observed statuses: ${endpoint.observedStatuses.join(', ') || 'none'}`);
    lines.push(`- Confidence: ${endpoint.confidence}`);
    for (const item of endpoint.evidence) lines.push(`- Evidence: ${item}`);
    for (const item of endpoint.warnings) lines.push(`- Warning: ${item}`);
    lines.push('');
  }
  lines.push('## Workflows', '');
  for (const workflow of contract.workflows) {
    lines.push(`### ${workflow.name}`, '');
    workflow.steps.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
    for (const flow of workflow.dataFlow) lines.push(`- Data flow: ${flow}`);
    lines.push(`- Confidence: ${workflow.confidence}`, '');
  }
  lines.push('## Uncertainties', '');
  for (const item of contract.uncertainties) lines.push(`- ${item}`);
  if (contract.nodejsSample) lines.push('', '## Optional Node.js sample', '', '```js', contract.nodejsSample, '```');
  return `${lines.join('\n')}\n`;
}

function normalizeContractPath(value) {
  return String(value || '')
    .split('?', 1)[0]
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/ig, ':param')
    .replace(/\{[^/}]+\}|:[^/]+/g, ':param')
    .replace(/\/+$/, '') || '/';
}

function evaluateContract(contract, contractInventory) {
  const expected = new Map(contractInventory.map((endpoint) => ([
    `${endpoint.method.toUpperCase()} ${normalizeContractPath(endpoint.path)}`,
    endpoint,
  ])));
  const claims = new Map(contract.endpoints.map((endpoint) => ([
    `${endpoint.method.toUpperCase()} ${normalizeContractPath(endpoint.path)}`,
    endpoint,
  ])));
  let matchedEndpoints = 0;
  let exactStatusSets = 0;
  for (const [key, endpoint] of expected) {
    const claim = claims.get(key);
    if (!claim) continue;
    matchedEndpoints += 1;
    const expectedStatuses = Object.keys(endpoint.observed.statusCounts || {}).map(Number).sort((a, b) => a - b);
    const claimedStatuses = [...new Set(claim.observedStatuses || [])].sort((a, b) => a - b);
    if (JSON.stringify(expectedStatuses) === JSON.stringify(claimedStatuses)) exactStatusSets += 1;
  }
  return {
    expectedEndpoints: expected.size,
    claimedEndpoints: claims.size,
    matchedEndpoints,
    endpointCoverage: round(matchedEndpoints / Math.max(expected.size, 1)),
    hallucinatedEndpoints: [...claims.keys()].filter((key) => !expected.has(key)),
    exactStatusSets,
    exactStatusSetAccuracy: round(exactStatusSets / Math.max(expected.size, 1)),
  };
}

async function main() {
  const workspace = path.resolve(__dirname, '..');
  const runId = timestampId();
  const recordingRoot = process.env.KEYMANAGER_RECORDING_ROOT
    ? path.resolve(process.env.KEYMANAGER_RECORDING_ROOT)
    : path.join(workspace, 'demo-data', 'keymanager-contract', runId);
  const farmRoot = path.join(workspace, 'output', 'keymanager-contract', runId);
  const resultRoot = process.env.KEYMANAGER_AB_OUTPUT
    ? path.resolve(process.env.KEYMANAGER_AB_OUTPUT)
    : path.join(workspace, 'generated', 'keymanager-contract-ab');
  fs.mkdirSync(recordingRoot, { recursive: true });
  fs.mkdirSync(farmRoot, { recursive: true });
  fs.mkdirSync(resultRoot, { recursive: true });

  if (!process.env.KEYMANAGER_RECORDING_ROOT) {
    if (!ADMIN_NAME) {
      throw new Error('KEYMANAGER_ADMIN_NAME is required when collecting new dashboard recordings');
    }
    for (let sessionNumber = 1; sessionNumber <= SESSION_COUNT; sessionNumber += 1) {
      await collectSession(recordingRoot, sessionNumber);
    }
  } else {
    console.log(`Reusing recordings: ${recordingRoot}`);
  }
  const farmed = await farmInput({
    inputDirectory: recordingRoot,
    outputDirectory: farmRoot,
  });
  const raw = sanitizeRaw(buildRawContext(recordingRoot, { pathPrefixes: ['/v1/'] }));
  const features = buildFeatureContext(farmRoot);
  const apiKeys = loadApiKeys(path.join(workspace, 'gemini-api-key.txt'));
  const matrix = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    target: TARGET,
    model: null,
    contextBudgetChars: CONTEXT_BUDGET_CHARS,
    collection: {
      sessions: SESSION_COUNT,
      iterationsPerSession: ITERATIONS_PER_SESSION,
      capturedRequests: farmed.summary.capturedRequestCount,
      crossSessionEndpoints: farmed.summary.crossSessionEndpoints.length,
      crossSessionRelations: farmed.summary.crossSessionRelations.length,
    },
    conditions: [],
  };

  for (const condition of CONDITIONS) {
    const evidence = buildBudgetedEvidence({
      condition,
      raw,
      features,
      budgetChars: CONTEXT_BUDGET_CHARS,
    });
    const generated = await generateJsonWithFallback({
      apiKeys,
      prompt: buildPrompt(condition, evidence),
      responseJsonSchema: CONTRACT_SCHEMA,
      maxOutputTokens: 12_000,
      seed: GENERATION_SEED,
    });
    matrix.model ||= generated.model;
    const conditionRoot = path.join(resultRoot, condition.id);
    fs.mkdirSync(conditionRoot, { recursive: true });
    fs.writeFileSync(path.join(conditionRoot, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    fs.writeFileSync(path.join(conditionRoot, 'contract.json'), `${JSON.stringify(generated.data, null, 2)}\n`);
    fs.writeFileSync(path.join(conditionRoot, 'contract.md'), renderContract(condition, generated));
    const evaluation = evaluateContract(generated.data, features.contractInventory);
    matrix.conditions.push({
      id: condition.id,
      label: condition.label,
      evidenceChars: JSON.stringify(evidence).length,
      promptTokens: generated.usageMetadata?.promptTokenCount || null,
      endpointClaims: generated.data.endpoints.length,
      workflowClaims: generated.data.workflows.length,
      seed: GENERATION_SEED,
      evaluation,
      responseId: generated.responseId,
    });
    console.log(`${condition.id}: ${generated.data.endpoints.length} endpoint claims`);
  }

  fs.writeFileSync(path.join(resultRoot, 'matrix.json'), `${JSON.stringify(matrix, null, 2)}\n`);
  fs.writeFileSync(path.join(resultRoot, 'farm-summary.json'), `${JSON.stringify(farmed.summary, null, 2)}\n`);
  console.log(`Contract A/B ready: ${resultRoot}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  CONTRACT_SCHEMA,
  buildPrompt,
  evaluateContract,
  normalizeContractPath,
  renderContract,
};
