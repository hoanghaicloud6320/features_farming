#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  CONDITIONS,
  buildFeatureContext,
  buildRawContext,
} = require('../src/gym-ab');
const {
  generateJsonWithFallback,
  loadApiKeys,
} = require('../src/gemini');

const CONTRACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'summary', 'cases', 'uncertainties', 'nodejsExample'],
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    cases: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['caseId', 'authentication', 'endpoints', 'workflows', 'uncertainties'],
        properties: {
          caseId: { type: 'string' },
          authentication: { type: 'string' },
          endpoints: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: [
                'method', 'path', 'observedStatuses', 'requestFields',
                'responseFields', 'purpose', 'confidence',
              ],
              properties: {
                method: { type: 'string' },
                path: { type: 'string' },
                observedStatuses: { type: 'array', items: { type: 'integer' } },
                requestFields: { type: 'array', items: { type: 'string' } },
                responseFields: { type: 'array', items: { type: 'string' } },
                purpose: { type: 'string' },
                confidence: { type: 'string', enum: ['observed', 'inferred', 'unknown'] },
              },
            },
          },
          workflows: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['steps', 'dataFlows', 'confidence'],
              properties: {
                steps: { type: 'array', items: { type: 'string' } },
                dataFlows: { type: 'array', items: { type: 'string' } },
                confidence: { type: 'string', enum: ['observed', 'inferred', 'unknown'] },
              },
            },
          },
          uncertainties: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    uncertainties: { type: 'array', items: { type: 'string' } },
    nodejsExample: { type: 'string' },
  },
};

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function round(value, digits = 3) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function mean(values) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

function latestDirectory(root) {
  if (!fs.existsSync(root)) throw new Error(`Directory does not exist: ${root}`);
  const directories = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!directories.length) throw new Error(`No directories found under: ${root}`);
  return directories[0];
}

function normalizePath(value) {
  return String(value || '')
    .split('?', 1)[0]
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/ig, ':param')
    .replace(/\/\d+(?=\/|$)/g, '/:param')
    .replace(/\{[^/}]+\}|:[^/]+/g, ':param')
    .replace(/\/+$/, '') || '/';
}

function endpointKey(endpoint) {
  return `${String(endpoint.method || 'GET').toUpperCase()} ${normalizePath(endpoint.path)}`;
}

function normalizeField(value) {
  return String(value || '')
    .replace(/^(?:request|response)\./, '')
    .replace(/^body\.json\$/, '')
    .replace(/^body\.form\$/, '')
    .replace(/^\./, '')
    .replace(/\[\d+\]/g, '[]')
    .toLowerCase();
}

function flattenFields(value, prefix = '', output = new Set(), depth = 0) {
  if (depth > 6 || output.size >= 30) return output;
  if (Array.isArray(value)) {
    if (prefix) output.add(`${prefix}[]`);
    if (value.length) flattenFields(value[0], `${prefix}[]`, output, depth + 1);
    return output;
  }
  if (!value || typeof value !== 'object') {
    if (prefix) output.add(prefix);
    return output;
  }
  for (const [key, child] of Object.entries(value)) {
    const next = prefix ? `${prefix}.${key}` : key;
    output.add(next);
    flattenFields(child, next, output, depth + 1);
  }
  return output;
}

function parsePostData(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function compactRaw(raw) {
  const endpointMap = new Map();
  let workflow = [];
  for (const session of raw.sessions || []) {
    const byIteration = new Map();
    for (const event of session.events || []) {
      let url;
      try {
        url = new URL(event.request.url);
      } catch {
        continue;
      }
      const endpoint = {
        method: event.request.method,
        path: url.pathname,
      };
      const key = endpointKey(endpoint);
      if (!endpointMap.has(key)) {
        endpointMap.set(key, {
          ...endpoint,
          statuses: new Set(),
          requestFields: new Set(),
          responseFields: new Set(),
        });
      }
      const current = endpointMap.get(key);
      if (event.response.status) current.statuses.add(event.response.status);
      flattenFields(parsePostData(event.request.postData), '', current.requestFields);
      flattenFields(event.response.body, '', current.responseFields);
      if (!byIteration.has(event.iterationId)) byIteration.set(event.iterationId, []);
      byIteration.get(event.iterationId).push(key);
    }
    if (!workflow.length && byIteration.size) {
      workflow = [...byIteration.values()][0].filter((key, index, values) => (
        index === 0 || key !== values[index - 1]
      ));
    }
  }
  return {
    kind: 'compact-direct-observations',
    endpoints: [...endpointMap.values()].map((endpoint) => ({
      method: endpoint.method,
      path: endpoint.path,
      observedStatuses: [...endpoint.statuses].sort((a, b) => a - b),
      requestFields: [...endpoint.requestFields].slice(0, 24),
      responseFields: [...endpoint.responseFields].slice(0, 24),
    })),
    observedWorkflow: workflow,
  };
}

function compactFeatures(features) {
  return {
    kind: 'compact-farmed-contract-evidence',
    contractInventory: (features.contractInventory || []).map((endpoint) => ({
      method: endpoint.method,
      path: endpoint.path,
      observedStatuses: Object.keys(endpoint.observed?.statusCounts || {}).map(Number),
      requestFields: (endpoint.requestFields || []).map((field) => field.path),
      responseFields: (endpoint.responseSchemas || []).map((field) => field.path),
      dataFlows: endpoint.dataFlows?.selected || [],
      warnings: endpoint.warnings || [],
    })),
    authenticationEvidence: features.authenticationEvidence,
    workflow: features.workflow,
  };
}

function truthFromFeatures(features) {
  return (features.contractInventory || []).map((endpoint) => ({
    method: endpoint.method,
    path: endpoint.path,
    statuses: Object.keys(endpoint.observed?.statusCounts || {}).map(Number).sort((a, b) => a - b),
    requestFields: (endpoint.requestFields || []).map((field) => normalizeField(field.path)).filter(Boolean),
    responseFields: (endpoint.responseSchemas || []).map((field) => normalizeField(field.path)).filter(Boolean),
  }));
}

function buildCase(id, recordingRoot, farmRoot, pathPrefixes = ['/api/']) {
  const features = buildFeatureContext(farmRoot);
  return {
    id,
    raw: compactRaw(buildRawContext(recordingRoot, { pathPrefixes })),
    features: compactFeatures(features),
    truth: truthFromFeatures(features),
  };
}

function manifestCases(file) {
  const manifest = readJson(file);
  return manifest.cases.map((item) => ({
    id: item.id,
    recordingRoot: item.recordings || item.recordingRoot,
    farmRoot: item.farm || item.farmRoot,
  }));
}

function directoryCases(recordingRoot, farmRoot) {
  return fs.readdirSync(farmRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => fs.existsSync(path.join(farmRoot, entry.name, 'cross-session.json')))
    .map((entry) => ({
      id: entry.name,
      recordingRoot: path.join(recordingRoot, entry.name),
      farmRoot: path.join(farmRoot, entry.name),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function loadSuites(workspace) {
  const legacyCases = ['easy', 'medium', 'hard'].map((id) => (
    buildCase(id, path.join(workspace, 'demo-data', 'gym', id), path.join(workspace, 'output', 'gym', id))
  ));
  const v4Cases = [
    buildCase(
      'noise',
      path.join(workspace, 'demo-data', 'gym', 'noise'),
      path.join(workspace, 'output', 'gym', 'noise'),
    ),
  ];
  const fromManifest = (environmentName, fallback) => {
    const manifestFile = process.env[environmentName]
      ? path.resolve(process.env[environmentName])
      : path.join(workspace, fallback);
    return manifestCases(manifestFile).map((item) => (
      buildCase(item.id, item.recordingRoot, item.farmRoot)
    ));
  };
  const v8Data = process.env.CONTRACT_V8_DATA_ROOT
    ? path.resolve(process.env.CONTRACT_V8_DATA_ROOT)
    : latestDirectory(path.join(workspace, 'demo-data', 'gym-v8'));
  const v8Farm = process.env.CONTRACT_V8_FARM_ROOT
    ? path.resolve(process.env.CONTRACT_V8_FARM_ROOT)
    : latestDirectory(path.join(workspace, 'output', 'gym-v8'));
  const v8Cases = directoryCases(v8Data, v8Farm).map((item) => (
    buildCase(item.id, item.recordingRoot, item.farmRoot)
  ));
  const keymanagerSource = process.env.CONTRACT_KEYMANAGER_SOURCE
    ? path.resolve(process.env.CONTRACT_KEYMANAGER_SOURCE)
    : path.join(workspace, 'generated', 'keymanager-contract-ab');
  const keymanagerFeatureEvidence = readJson(path.join(keymanagerSource, 'features', 'evidence.json'));
  const keymanagerCases = [{
    id: 'keymanager',
    raw: readJson(path.join(keymanagerSource, 'raw', 'evidence.json')).rawTimeline,
    features: keymanagerFeatureEvidence.farmedFeatures,
    truth: truthFromFeatures(keymanagerFeatureEvidence.farmedFeatures),
    evidenceByArm: Object.fromEntries(CONDITIONS.map((condition) => [
      condition.id,
      readJson(path.join(keymanagerSource, condition.id, 'evidence.json')),
    ])),
  }];
  return [
    { id: 'v1', label: 'Gym V1 diagnostic', cases: legacyCases, seed: 101_001 },
    { id: 'v2', label: 'Gym V2 diagnostic', cases: legacyCases, seed: 102_001 },
    { id: 'v3', label: 'Gym V3 canonical', cases: legacyCases, seed: 103_001 },
    { id: 'v4', label: 'Gym V4 noise', cases: v4Cases, seed: 104_001 },
    {
      id: 'v5',
      label: 'Gym V5',
      cases: fromManifest('CONTRACT_V5_MANIFEST', 'generated/gym-ab-v5-lineage-rerun/manifest.json'),
      seed: 105_001,
    },
    {
      id: 'v6',
      label: 'Gym V6',
      cases: fromManifest('CONTRACT_V6_MANIFEST', 'generated/gym-ab-v6-lineage-rerun/manifest.json'),
      seed: 106_001,
    },
    {
      id: 'v7',
      label: 'Gym V7',
      cases: fromManifest('CONTRACT_V7_MANIFEST', 'generated/gym-ab-v7/manifest.json'),
      seed: 107_001,
    },
    { id: 'v8', label: 'Gym V8', cases: v8Cases, seed: 108_001 },
    { id: 'keymanager', label: 'KeyManager', cases: keymanagerCases, seed: 109_001 },
  ];
}

function evidenceFor(suite, condition) {
  return {
    suite: suite.id,
    cases: suite.cases.map((item) => {
      if (item.evidenceByArm) {
        return { caseId: item.id, ...item.evidenceByArm[condition.id] };
      }
      return {
        caseId: item.id,
        rawTimeline: condition.raw ? item.raw : null,
        farmedFeatures: condition.features ? item.features : null,
      };
    }),
  };
}

function promptFor(suite, condition, evidence) {
  const caseIds = suite.cases.map((item) => item.id);
  return [
    'Generate an observed API contract from the supplied browser-traffic evidence.',
    'The primary output is the contract, not executable automation.',
    'A single short Node.js fetch example is optional and must remain secondary.',
    'Use only evidence supplied here. Do not invent routes, statuses, fields, authentication, or semantics.',
    'Return every requested caseId exactly once. With no evidence, return empty endpoint lists and state the uncertainty.',
    'Farmed contractInventory is authoritative concrete endpoint attribution. Transcribe it; do not generalize or rematch siblings.',
    'Raw timelines are direct observations and contain no inferred relations.',
    'Keep requestFields and responseFields as compact dotted paths.',
    `Suite: ${suite.label}`,
    `Evidence arm: ${condition.label}`,
    `Required case IDs: ${JSON.stringify(caseIds)}`,
    '',
    'EVIDENCE JSON:',
    JSON.stringify(evidence),
  ].join('\n');
}

function setMetrics(expectedValues, claimedValues) {
  const expected = new Set(expectedValues);
  const claimed = new Set(claimedValues);
  let matched = 0;
  for (const value of claimed) if (expected.has(value)) matched += 1;
  const precision = claimed.size ? matched / claimed.size : (expected.size ? 0 : 1);
  const recall = expected.size ? matched / expected.size : 1;
  return {
    matched,
    expected: expected.size,
    claimed: claimed.size,
    precision,
    recall,
    f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0,
  };
}

function evaluateSuite(suite, contract) {
  const claimsByCase = new Map((contract.cases || []).map((item) => [item.caseId, item]));
  const totals = {
    endpointExpected: 0,
    endpointClaimed: 0,
    endpointMatched: 0,
    exactStatuses: 0,
    requestExpected: 0,
    requestMatched: 0,
    responseExpected: 0,
    responseMatched: 0,
    hallucinatedEndpoints: 0,
    completeCases: 0,
  };
  const cases = suite.cases.map((item) => {
    const claim = claimsByCase.get(item.id) || { endpoints: [] };
    const expectedMap = new Map(item.truth.map((endpoint) => [endpointKey(endpoint), endpoint]));
    const claimMap = new Map((claim.endpoints || []).map((endpoint) => [endpointKey(endpoint), endpoint]));
    let exactStatuses = 0;
    let requestExpected = 0;
    let requestMatched = 0;
    let responseExpected = 0;
    let responseMatched = 0;
    for (const [key, expected] of expectedMap) {
      const endpoint = claimMap.get(key);
      if (!endpoint) continue;
      const expectedStatuses = [...new Set(expected.statuses)].sort((a, b) => a - b);
      const claimedStatuses = [...new Set(endpoint.observedStatuses || [])].sort((a, b) => a - b);
      if (JSON.stringify(expectedStatuses) === JSON.stringify(claimedStatuses)) exactStatuses += 1;
      const requests = setMetrics(
        expected.requestFields,
        (endpoint.requestFields || []).map(normalizeField).filter(Boolean),
      );
      const responses = setMetrics(
        expected.responseFields,
        (endpoint.responseFields || []).map(normalizeField).filter(Boolean),
      );
      requestExpected += requests.expected;
      requestMatched += requests.matched;
      responseExpected += responses.expected;
      responseMatched += responses.matched;
    }
    const endpoints = setMetrics([...expectedMap.keys()], [...claimMap.keys()]);
    const hallucinated = [...claimMap.keys()].filter((key) => !expectedMap.has(key));
    const complete = endpoints.recall === 1
      && exactStatuses === expectedMap.size
      && hallucinated.length === 0;
    totals.endpointExpected += endpoints.expected;
    totals.endpointClaimed += endpoints.claimed;
    totals.endpointMatched += endpoints.matched;
    totals.exactStatuses += exactStatuses;
    totals.requestExpected += requestExpected;
    totals.requestMatched += requestMatched;
    totals.responseExpected += responseExpected;
    totals.responseMatched += responseMatched;
    totals.hallucinatedEndpoints += hallucinated.length;
    if (complete) totals.completeCases += 1;
    return {
      caseId: item.id,
      endpointRecall: round(endpoints.recall),
      endpointPrecision: round(endpoints.precision),
      exactStatusAccuracy: round(exactStatuses / Math.max(expectedMap.size, 1)),
      hallucinatedEndpoints: hallucinated,
      complete,
    };
  });
  const endpointPrecision = totals.endpointClaimed
    ? totals.endpointMatched / totals.endpointClaimed
    : (totals.endpointExpected ? 0 : 1);
  const endpointRecall = totals.endpointExpected
    ? totals.endpointMatched / totals.endpointExpected
    : 1;
  const endpointF1 = endpointPrecision + endpointRecall
    ? (2 * endpointPrecision * endpointRecall) / (endpointPrecision + endpointRecall)
    : 0;
  const statusAccuracy = totals.exactStatuses / Math.max(totals.endpointExpected, 1);
  const requestRecall = totals.requestMatched / Math.max(totals.requestExpected, 1);
  const responseRecall = totals.responseMatched / Math.max(totals.responseExpected, 1);
  const noHallucination = totals.hallucinatedEndpoints === 0 ? 1 : 0;
  const qualityScore = 100 * (
    (0.4 * endpointF1)
    + (0.2 * statusAccuracy)
    + (0.15 * requestRecall)
    + (0.15 * responseRecall)
    + (0.1 * noHallucination)
  );
  return {
    caseCount: suite.cases.length,
    completeCaseRate: round(totals.completeCases / Math.max(suite.cases.length, 1)),
    endpointPrecision: round(endpointPrecision),
    endpointRecall: round(endpointRecall),
    endpointF1: round(endpointF1),
    exactStatusAccuracy: round(statusAccuracy),
    requestFieldRecall: round(requestRecall),
    responseFieldRecall: round(responseRecall),
    hallucinatedEndpoints: totals.hallucinatedEndpoints,
    qualityScore: round(qualityScore, 2),
    cases,
  };
}

function markdownReport(result) {
  const lines = [
    '# Contract generation matrix',
    '',
    `Model: \`${result.model}\``,
    '',
    '| Suite | Arm | Cases | Quality /100 | Endpoint F1 | Exact statuses | Complete cases | Tokens/case | Latency s | Complete cases / 1k tokens |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const run of result.runs) {
    lines.push(
      `| ${run.suite} | ${run.arm} | ${run.evaluation.caseCount} `
      + `| ${run.evaluation.qualityScore.toFixed(2)} `
      + `| ${(run.evaluation.endpointF1 * 100).toFixed(1)}% `
      + `| ${(run.evaluation.exactStatusAccuracy * 100).toFixed(1)}% `
      + `| ${(run.evaluation.completeCaseRate * 100).toFixed(1)}% `
      + `| ${run.tokensPerCase ?? '-'} `
      + `| ${(run.latencyMs / 1000).toFixed(2)} `
      + `| ${run.completeCasesPer1kTokens ?? '-'} |`,
    );
  }
  lines.push(
    '',
    'Quality weights: endpoint F1 40%, exact status sets 20%, request-field recall 15%, response-field recall 15%, and no hallucinated endpoints 10%.',
    '',
    'Complete-contract token efficiency is the number of cases with full endpoint coverage, exact status sets, and no hallucinated endpoints per 1,000 prompt tokens. Quality points per 1,000 tokens remain available in matrix.json.',
    '',
    'V1, V2, and V3 intentionally share the original three recordings but use different model seeds. This measures generation variance without pretending they are distinct datasets.',
    '',
  );
  return lines.join('\n');
}

async function main() {
  const workspace = path.resolve(__dirname, '..');
  const outputRoot = process.env.CONTRACT_MATRIX_OUTPUT
    ? path.resolve(process.env.CONTRACT_MATRIX_OUTPUT)
    : path.join(workspace, 'generated', 'contract-matrix-rerun');
  const selected = process.env.CONTRACT_SUITES
    ? new Set(process.env.CONTRACT_SUITES.split(',').map((value) => value.trim()).filter(Boolean))
    : null;
  const suites = loadSuites(workspace).filter((suite) => !selected || selected.has(suite.id));
  if (!suites.length) throw new Error('No contract suites selected');
  const rescoreExisting = process.env.CONTRACT_MATRIX_RESCORE === '1';
  const apiKeys = rescoreExisting
    ? []
    : loadApiKeys(path.join(workspace, 'gemini-api-key.txt'));
  const result = {
    schemaVersion: 1,
    benchmark: 'all-versions-contract-generation',
    generatedAt: new Date().toISOString(),
    model: null,
    suites: suites.map((suite) => ({ id: suite.id, label: suite.label, cases: suite.cases.length })),
    runs: [],
    aggregates: [],
  };
  fs.mkdirSync(outputRoot, { recursive: true });
  for (const suite of suites) {
    for (const condition of CONDITIONS) {
      const evidence = evidenceFor(suite, condition);
      const runRoot = path.join(outputRoot, suite.id, condition.id);
      let generated;
      let latencyMs;
      let priorRun = null;
      if (rescoreExisting) {
        const contractFile = path.join(runRoot, 'contract.json');
        const runFile = path.join(runRoot, 'run.json');
        if (!fs.existsSync(contractFile) || !fs.existsSync(runFile)) {
          throw new Error(`Cannot rescore missing artifacts: ${runRoot}`);
        }
        priorRun = readJson(runFile);
        generated = {
          data: readJson(contractFile),
          model: priorRun.model || 'gemini-3.1-flash-lite',
          usageMetadata: {
            promptTokenCount: priorRun.usage?.promptTokens,
            candidatesTokenCount: priorRun.usage?.outputTokens,
            totalTokenCount: priorRun.usage?.totalTokens,
          },
          responseId: priorRun.responseId,
        };
        latencyMs = priorRun.latencyMs;
      } else {
        const startedAt = Date.now();
        generated = await generateJsonWithFallback({
          apiKeys,
          prompt: promptFor(suite, condition, evidence),
          responseJsonSchema: CONTRACT_SCHEMA,
          maxOutputTokens: 32_000,
          seed: suite.seed,
        });
        latencyMs = Date.now() - startedAt;
      }
      result.model ||= generated.model;
      const evaluation = evaluateSuite(suite, generated.data);
      const promptTokens = generated.usageMetadata?.promptTokenCount || null;
      const run = {
        suite: suite.id,
        suiteLabel: suite.label,
        arm: condition.id,
        seed: suite.seed,
        evidenceChars: JSON.stringify(evidence).length,
        latencyMs,
        usage: {
          promptTokens,
          outputTokens: generated.usageMetadata?.candidatesTokenCount || null,
          totalTokens: generated.usageMetadata?.totalTokenCount || null,
        },
        tokenEfficiency: promptTokens
          ? round((evaluation.qualityScore * 1000) / promptTokens, 2)
          : null,
        tokensPerCase: promptTokens
          ? round(promptTokens / Math.max(evaluation.caseCount, 1), 1)
          : null,
        completeCasesPer1kTokens: promptTokens
          ? round(
            (
              evaluation.completeCaseRate
              * evaluation.caseCount
              * 1000
            ) / promptTokens,
            3,
          )
          : null,
        evaluation,
        responseId: generated.responseId,
      };
      result.runs.push(run);
      fs.mkdirSync(runRoot, { recursive: true });
      if (!rescoreExisting) {
        fs.writeFileSync(path.join(runRoot, 'contract.json'), `${JSON.stringify(generated.data, null, 2)}\n`);
      }
      fs.writeFileSync(path.join(runRoot, 'run.json'), `${JSON.stringify(run, null, 2)}\n`);
      console.log(
        `${suite.id} ${condition.id}: quality ${evaluation.qualityScore}/100, `
        + `endpoint F1 ${(evaluation.endpointF1 * 100).toFixed(1)}%, tokens ${promptTokens ?? 'n/a'}`,
      );
    }
  }
  result.aggregates = CONDITIONS.map((condition) => {
    const runs = result.runs.filter((run) => run.arm === condition.id);
    const totalCases = runs.reduce((sum, run) => sum + run.evaluation.caseCount, 0);
    const totalPromptTokens = runs.reduce((sum, run) => sum + (run.usage.promptTokens || 0), 0);
    const totalCompleteCases = runs.reduce((sum, run) => (
      sum + (run.evaluation.completeCaseRate * run.evaluation.caseCount)
    ), 0);
    return {
      arm: condition.id,
      runs: runs.length,
      totalCases,
      meanQualityScore: round(mean(runs.map((run) => run.evaluation.qualityScore)), 2),
      meanEndpointF1: round(mean(runs.map((run) => run.evaluation.endpointF1))),
      meanExactStatusAccuracy: round(mean(runs.map((run) => run.evaluation.exactStatusAccuracy))),
      meanCompleteCaseRate: round(mean(runs.map((run) => run.evaluation.completeCaseRate))),
      meanPromptTokens: round(mean(runs.map((run) => run.usage.promptTokens).filter(Number.isFinite)), 1),
      meanLatencyMs: round(mean(runs.map((run) => run.latencyMs)), 1),
      meanTokenEfficiency: round(mean(runs.map((run) => run.tokenEfficiency).filter(Number.isFinite)), 2),
      promptTokensPerCase: round(totalPromptTokens / Math.max(totalCases, 1), 1),
      completeCasesPer1kTokens: round(
        (totalCompleteCases * 1000) / Math.max(totalPromptTokens, 1),
        3,
      ),
    };
  });
  fs.writeFileSync(path.join(outputRoot, 'matrix.json'), `${JSON.stringify(result, null, 2)}\n`);
  fs.writeFileSync(path.join(outputRoot, 'matrix.md'), `${markdownReport(result)}\n`);
  console.log(`Contract matrix: ${path.join(outputRoot, 'matrix.md')}`);
  return result;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  CONTRACT_SCHEMA,
  compactFeatures,
  compactRaw,
  evaluateSuite,
  normalizeField,
  normalizePath,
};
