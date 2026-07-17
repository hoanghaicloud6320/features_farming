'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { CHALLENGES } = require('../gym/challenges');
const { generateJsonWithFallback } = require('./gemini');

const execFileAsync = promisify(execFile);

const CONDITIONS = [
  { id: 'none', label: 'No evidence', raw: false, features: false },
  { id: 'raw', label: 'Raw recorder', raw: true, features: false },
  { id: 'features', label: 'Farmed features', raw: false, features: true },
  { id: 'raw-features', label: 'Raw + features', raw: true, features: true },
];

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['assessment', 'code'],
  properties: {
    assessment: {
      type: 'object',
      additionalProperties: false,
      required: ['approach', 'evidenceUsed', 'uncertainties'],
      properties: {
        approach: { type: 'string' },
        evidenceUsed: { type: 'array', items: { type: 'string' } },
        uncertainties: { type: 'array', items: { type: 'string' } },
      },
    },
    code: { type: 'string' },
  },
};

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function responseBody(recordingDirectory, record) {
  if (!record.body?.file) return null;
  const file = path.join(recordingDirectory, record.body.file);
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function selectHeaders(headers = {}) {
  const keep = new Set(['authorization', 'content-type', 'x-gym-benchmark-run']);
  return Object.fromEntries(
    Object.entries(headers)
      .filter(([key]) => keep.has(key.toLowerCase()))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

function buildRawContext(recordingRoot, options = {}) {
  const pathPrefixes = options.pathPrefixes || ['/api/'];
  const directories = fs.readdirSync(recordingRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(recordingRoot, entry.name))
    .filter((directory) => fs.existsSync(path.join(directory, 'requests.json')))
    .sort();
  return {
    kind: 'raw-http-timeline-projection',
    note: 'Direct request/response observations. Only browser transport noise was omitted; no relations were inferred.',
    sessions: directories.map((directory) => ({
      recordingId: path.basename(directory),
      events: readJson(path.join(directory, 'requests.json'))
        .filter((record) => (
          record.iterationId
          && pathPrefixes.some((prefix) => new URL(record.request.url).pathname.startsWith(prefix))
        ))
        .map((record) => ({
          iterationId: record.iterationId,
          request: {
            method: record.request.method,
            url: record.request.url,
            headers: selectHeaders(record.request.headers),
            postData: record.request.postData || null,
          },
          response: {
            status: record.response?.status || null,
            headers: selectHeaders(record.response?.headers),
            body: responseBody(directory, record),
          },
        })),
    })),
  };
}

function buildFeatureContext(farmRoot) {
  const summary = readJson(path.join(farmRoot, 'cross-session.json'));
  const generalizationWarnings = summary.crossSessionEndpoints
    .filter((endpoint) => endpoint.signature.includes(':var'))
    .map((endpoint) => ({
      endpoint: endpoint.signature,
      concreteExamples: [...new Set((endpoint.examples || []).map((example) => {
        try {
          const url = new URL(example);
          return `${endpoint.routeKey.split(' ', 1)[0]} ${url.pathname}${url.search}`;
        } catch {
          return example;
        }
      }))],
      warning: 'Concrete sibling names are recoverable from examples, but request fields, response schemas, query keys, and statuses are aggregated at the generalized endpoint level and may differ by sibling.',
    }));
  return {
    kind: 'machine-farmed-features',
    collection: {
      sessionCount: summary.sessionCount,
      iterationCount: summary.iterationCount,
      capturedRequestCount: summary.capturedRequestCount,
    },
    endpoints: summary.crossSessionEndpoints,
    relations: summary.crossSessionRelations,
    workflow: summary.consensusWorkflow,
    fields: summary.crossSessionFields,
    schemas: summary.crossSessionSchemas,
    patterns: summary.patternTotals,
    generalizationWarnings,
  };
}

function jsonChars(value) {
  return JSON.stringify(value).length;
}

function compactRawEvent(event, maxChars = 3_800) {
  if (jsonChars(event) <= maxChars) return event;
  const bodyText = JSON.stringify(event.response?.body ?? null);
  return {
    iterationId: event.iterationId,
    request: event.request,
    response: {
      status: event.response?.status,
      headers: event.response?.headers,
      body: {
        truncated: true,
        originalChars: bodyText.length,
        preview: bodyText.slice(0, Math.max(300, maxChars - jsonChars(event.request) - 500)),
      },
    },
  };
}

function compactRawContext(raw, budgetChars) {
  if (!Number.isFinite(budgetChars)) return raw;
  const compact = {
    kind: raw.kind,
    note: `${raw.note} Context budget applied; large bodies and middle events may be omitted.`,
    budgetChars,
    sessions: [],
  };
  let omittedEvents = 0;
  for (const session of raw.sessions) {
    const events = session.events;
    const order = [];
    if (events[0]) order.push(events[0]);
    if (events.length > 1) order.push(events.at(-1));
    for (let index = 1; index < events.length - 1; index += 1) order.push(events[index]);
    const selected = [];
    for (const event of order) {
      const candidate = compactRawEvent(event);
      const next = {
        ...compact,
        sessions: [...compact.sessions, {
          recordingId: session.recordingId,
          originalEventCount: events.length,
          events: [...selected, candidate],
        }],
      };
      if (jsonChars(next) > budgetChars) {
        continue;
      }
      selected.push(candidate);
    }
    if (selected.length) {
      compact.sessions.push({
        recordingId: session.recordingId,
        originalEventCount: events.length,
        events: selected,
      });
      omittedEvents += Math.max(0, events.length - selected.length);
    } else {
      omittedEvents += events.length;
    }
  }
  compact.omittedEvents = omittedEvents;
  while (jsonChars(compact) > budgetChars) {
    const session = [...compact.sessions].reverse().find((candidate) => candidate.events.length > 2);
    if (!session) break;
    session.events.pop();
    compact.omittedEvents += 1;
  }
  return compact;
}

function compactFeatureContext(features, budgetChars) {
  if (!Number.isFinite(budgetChars)) return features;
  const coreEndpoints = features.endpoints.filter((endpoint) => endpoint.classifications.includes('core'));
  const coreSignatures = new Set(coreEndpoints.map((endpoint) => endpoint.signature));
  const compact = {
    kind: features.kind,
    collection: features.collection,
    budgetChars,
    endpoints: coreEndpoints,
    relations: features.relations.filter((relation) => (
      coreSignatures.has(relation.sourceEndpoint) && coreSignatures.has(relation.targetEndpoint)
    )),
    workflow: features.workflow,
    patterns: features.patterns,
    generalizationWarnings: features.generalizationWarnings || [],
    fields: features.fields.filter((field) => coreSignatures.has(field.endpoint)),
    schemas: features.schemas.filter((schema) => coreSignatures.has(schema.endpoint)),
  };
  for (const key of ['fields', 'schemas']) {
    while (compact[key].length && jsonChars(compact) > budgetChars) compact[key].pop();
  }
  if (jsonChars(compact) > budgetChars) {
    compact.relations = compact.relations.map((relation) => ({
      kind: relation.kind,
      source: relation.source,
      target: relation.target,
      sessionPresence: relation.sessionPresence,
      supportIterations: relation.supportIterations,
      transforms: relation.transforms,
    }));
  }
  while (compact.relations.length && jsonChars(compact) > budgetChars) compact.relations.pop();
  while (compact.workflow.length && jsonChars(compact) > budgetChars) compact.workflow.pop();
  if (jsonChars(compact) > budgetChars) compact.patterns = {};
  compact.omitted = {
    endpoints: features.endpoints.length - compact.endpoints.length,
    relations: features.relations.length - compact.relations.length,
    workflow: features.workflow.length - compact.workflow.length,
    fields: features.fields.length - compact.fields.length,
    schemas: features.schemas.length - compact.schemas.length,
  };
  for (const key of ['fields', 'schemas']) {
    while (compact[key].length && jsonChars(compact) > budgetChars) compact[key].pop();
  }
  while (compact.relations.length && jsonChars(compact) > budgetChars) compact.relations.pop();
  while (compact.workflow.length && jsonChars(compact) > budgetChars) compact.workflow.pop();
  while (compact.endpoints.length > 1 && jsonChars(compact) > budgetChars) compact.endpoints.pop();
  if (jsonChars(compact) > budgetChars) {
    compact.collection = {};
    compact.omitted = { budgetExhausted: true };
  }
  return compact;
}

function buildBudgetedEvidence({ condition, raw, features, budgetChars = Infinity }) {
  if (!Number.isFinite(budgetChars)) {
    return {
      rawTimeline: condition.raw ? raw : null,
      farmedFeatures: condition.features ? features : null,
    };
  }
  if (condition.raw && condition.features) {
    const featureBudget = Math.floor(budgetChars * 0.67);
    const envelopeReserve = 240;
    return {
      farmedFeatures: compactFeatureContext(features, featureBudget),
      rawTimeline: compactRawContext(raw, budgetChars - featureBudget - envelopeReserve),
      budget: {
        totalChars: budgetChars,
        featureChars: featureBudget,
        rawChars: budgetChars - featureBudget - envelopeReserve,
        envelopeReserve,
      },
    };
  }
  const envelopeReserve = 128;
  const payloadBudget = Math.max(0, budgetChars - envelopeReserve);
  return {
    rawTimeline: condition.raw ? compactRawContext(raw, payloadBudget) : null,
    farmedFeatures: condition.features ? compactFeatureContext(features, payloadBudget) : null,
    budget: { totalChars: budgetChars, envelopeReserve },
  };
}

function buildPrompt({ challenge, origin, benchmarkRunId, evidence }) {
  return [
    'You are in a contamination-free automation benchmark against a newly-created localhost website.',
    'You have no browser, tools, documentation, source code, or prior knowledge of this website.',
    'Use only the EVIDENCE JSON supplied below. Do not invent undocumented routes when evidence is available.',
    `Target origin: ${origin}`,
    `Challenge: ${challenge.title} (${challenge.id})`,
    `Goal: complete the challenge so its final JSON response contains {"accepted":true,"challenge":"${challenge.id}"}.`,
    'Return one complete CommonJS Node.js 20+ node:test file using built-in fetch and node:assert/strict.',
    "The file must start with these CommonJS declarations (no ESM import syntax): const test = require('node:test'); const assert = require('node:assert/strict');",
    'You may also use node:crypto and Buffer. Do not use any external package.',
    'Every HTTP request must target the exact target origin and include header:',
    `x-gym-benchmark-run: ${benchmarkRunId}`,
    'Make at most 6 HTTP requests. Assert status codes and the final accepted response.',
    'Do not read files, environment variables, source maps, page HTML/JavaScript, or spawn processes.',
    'Do not use discovery scans, alternate hosts, eval, dynamic imports, or network modules.',
    'Your code will be executed once against a fresh live server. A prose guess receives no credit.',
    '',
    'EVIDENCE JSON:',
    JSON.stringify(evidence, null, 2),
  ].join('\n');
}

function validateCode(code, origin, benchmarkRunId) {
  if (typeof code !== 'string' || code.length < 80 || code.length > 30_000) {
    throw new Error('Generated code length is invalid');
  }
  const forbidden = [
    /\bchild_process\b/i,
    /\b(?:node:)?(?:fs|net|tls|dgram|worker_threads)\b/i,
    /\bprocess\s*\.\s*env\b/i,
    /\beval\s*\(/i,
    /\bnew\s+Function\b/i,
    /\bimport\s*\(/i,
    /^\s*import\s/m,
    /\bexec(?:File|Sync)?\s*\(/i,
    /\bspawn(?:Sync)?\s*\(/i,
  ];
  const violation = forbidden.find((pattern) => pattern.test(code));
  if (violation) throw new Error(`Generated code rejected: ${violation}`);
  const urls = code.match(/https?:\/\/[^\s'"`)]+/g) || [];
  if (!urls.length || urls.some((url) => !url.startsWith(origin))) {
    throw new Error('Generated code contains a missing or foreign HTTP origin');
  }
  if (!code.includes('node:test') || !code.includes('node:assert/strict')) {
    throw new Error('Generated code must use node:test and node:assert/strict');
  }
  if (!code.toLowerCase().includes('x-gym-benchmark-run') || !code.includes(benchmarkRunId)) {
    throw new Error('Generated code omitted the benchmark tracking header');
  }
}

async function executeTest(file) {
  const startedAt = Date.now();
  try {
    const result = await execFileAsync(process.execPath, ['--test', path.basename(file)], {
      cwd: path.dirname(file),
      timeout: 15_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return {
      exitCode: 0,
      durationMs: Date.now() - startedAt,
      stdout: result.stdout.slice(-4000),
      stderr: result.stderr.slice(-4000),
    };
  } catch (error) {
    return {
      exitCode: Number.isInteger(error.code) ? error.code : 1,
      durationMs: Date.now() - startedAt,
      timedOut: Boolean(error.killed),
      stdout: String(error.stdout || '').slice(-4000),
      stderr: String(error.stderr || error.message || '').slice(-4000),
    };
  }
}

function scoreResult(challenge, execution, metrics) {
  const covered = new Set(metrics.requests.map((request) => request.route));
  const routeCoverage = challenge.routes.filter((route) => covered.has(route)).length / challenge.routes.length;
  const score = (
    (metrics.accepted ? 6 : 0)
    + (execution?.exitCode === 0 ? 1 : 0)
    + (routeCoverage * 3)
  );
  return {
    accepted: metrics.accepted,
    testPassed: execution?.exitCode === 0,
    routesCovered: challenge.routes.filter((route) => covered.has(route)),
    expectedRoutes: challenge.routes,
    routeCoverage: Math.round(routeCoverage * 1000) / 1000,
    score: Math.round(score * 100) / 100,
  };
}

function markdownReport(result) {
  const lines = [
    '# Local Gym A/B Matrix',
    '',
    `- Model: \`${result.model}\``,
    `- Design: ${result.challenges.length} challenges × ${result.conditions.length} evidence conditions × ${result.trials} fixed-seed trial(s)`,
    `- Evidence budget: ${Number.isFinite(result.contextBudgetChars) ? `${result.contextBudgetChars} JSON characters per cell` : 'unlimited'}`,
    '- Primary outcome: hidden server accepted the completed workflow.',
    '- Score: 6 acceptance + 3 route coverage + 1 clean node:test exit.',
    '',
    '| Challenge | Trial | Evidence | Accepted | Route coverage | Requests | Score / 10 |',
    '|---|---:|---|---:|---:|---:|---:|',
  ];
  for (const challenge of result.challenges) {
    for (const cell of challenge.cells) {
      lines.push(
        `| ${challenge.id} | ${cell.trial} | ${cell.conditionLabel} | ${cell.score.accepted ? 'yes' : 'no'} | ${Math.round(cell.score.routeCoverage * 100)}% | ${cell.metrics.requests.length} | ${cell.score.score.toFixed(2)} |`,
      );
    }
  }
  lines.push('', '## Aggregate by evidence condition', '');
  lines.push('| Evidence | Accepted workflows | Mean score | Mean requests | Mean prompt tokens |');
  lines.push('|---|---:|---:|---:|---:|');
  for (const aggregate of result.aggregates) {
    lines.push(`| ${aggregate.label} | ${aggregate.accepted}/${aggregate.total} | ${aggregate.meanScore.toFixed(2)} | ${aggregate.meanRequests.toFixed(2)} | ${aggregate.meanPromptTokens?.toFixed(0) || 'n/a'} |`);
  }
  lines.push('', '## Interpretation guardrails', '');
  lines.push('- The website and opaque routes were created immediately before this run; the model received no browsing tools or source code.');
  lines.push('- The raw arm receives a transport-noise-reduced HTTP timeline projection, but no inferred relation labels.');
  lines.push(`- This run has ${result.trials} fixed-seed trial(s) per cell.`);
  lines.push('- A hidden server metric prevents code that merely exits cleanly from being counted as successful.');
  return `${lines.join('\n')}\n`;
}

async function runGymMatrix({
  apiKeys,
  origin,
  gym,
  recordingRoot,
  farmRoot,
  outputRoot,
  challengeIds = Object.keys(CHALLENGES),
  trials = 1,
  contextBudgetChars = Infinity,
}) {
  fs.mkdirSync(outputRoot, { recursive: true });
  const result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    model: null,
    conditions: CONDITIONS,
    trials,
    contextBudgetChars,
    challenges: [],
  };
  const selectedChallenges = challengeIds.map((id) => {
    if (!CHALLENGES[id]) throw new Error(`Unknown gym challenge: ${id}`);
    return CHALLENGES[id];
  });
  for (let challengeIndex = 0; challengeIndex < selectedChallenges.length; challengeIndex += 1) {
    const challenge = selectedChallenges[challengeIndex];
    const raw = buildRawContext(path.join(recordingRoot, challenge.id));
    const features = buildFeatureContext(path.join(farmRoot, challenge.id));
    const challengeResult = { id: challenge.id, difficulty: challenge.difficulty, cells: [] };
    for (let conditionIndex = 0; conditionIndex < CONDITIONS.length; conditionIndex += 1) {
      const condition = CONDITIONS[conditionIndex];
      for (let trial = 1; trial <= trials; trial += 1) {
        const benchmarkRunId = `gym-${challenge.id}-${condition.id}-t${trial}-${crypto.randomBytes(4).toString('hex')}`;
        const evidence = buildBudgetedEvidence({ condition, raw, features, budgetChars: contextBudgetChars });
        const prompt = buildPrompt({ challenge, origin, benchmarkRunId, evidence });
        const cellDirectory = path.join(outputRoot, challenge.id, condition.id, `trial-${trial}`);
        fs.mkdirSync(cellDirectory, { recursive: true });
        fs.writeFileSync(path.join(cellDirectory, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
        const cell = {
          condition: condition.id,
          conditionLabel: condition.label,
          trial,
          benchmarkRunId,
          evidenceBytes: Buffer.byteLength(JSON.stringify(evidence)),
          promptHash: crypto.createHash('sha256').update(prompt).digest('hex'),
        };
        try {
          const generated = await generateJsonWithFallback({
            apiKeys,
            prompt,
            responseJsonSchema: RESPONSE_SCHEMA,
            maxOutputTokens: 8_000,
            seed: 84_000 + (challengeIndex * 100) + trial,
          });
          result.model ||= generated.model;
          const code = generated.data.code.trim();
          validateCode(code, origin, benchmarkRunId);
          const testFile = path.join(cellDirectory, 'automation.test.js');
          fs.writeFileSync(testFile, `${code}\n`);
          fs.writeFileSync(path.join(cellDirectory, 'assessment.json'), `${JSON.stringify(generated.data.assessment, null, 2)}\n`);
          const execution = await executeTest(testFile);
          const metrics = gym.getMetrics(benchmarkRunId);
          cell.gemini = {
            keyIndex: generated.keyIndex,
            usageMetadata: generated.usageMetadata,
            responseId: generated.responseId,
            assessment: generated.data.assessment,
          };
          cell.execution = execution;
          cell.metrics = metrics;
          cell.score = scoreResult(challenge, execution, metrics);
        } catch (error) {
          const metrics = gym.getMetrics(benchmarkRunId);
          cell.error = error.message;
          cell.metrics = metrics;
          cell.score = scoreResult(challenge, null, metrics);
        }
        fs.writeFileSync(path.join(cellDirectory, 'result.json'), `${JSON.stringify(cell, null, 2)}\n`);
        challengeResult.cells.push(cell);
        console.log(`${challenge.id}/${condition.id}/trial-${trial}: accepted=${cell.score.accepted} score=${cell.score.score}`);
      }
    }
    result.challenges.push(challengeResult);
  }
  result.aggregates = CONDITIONS.map((condition) => {
    const cells = result.challenges.flatMap((challenge) => (
      challenge.cells.filter((cell) => cell.condition === condition.id)
    ));
    const promptTokens = cells
      .map((cell) => cell.gemini?.usageMetadata?.promptTokenCount)
      .filter(Number.isFinite);
    return {
      condition: condition.id,
      label: condition.label,
      accepted: cells.filter((cell) => cell.score.accepted).length,
      total: cells.length,
      meanScore: Math.round((cells.reduce((sum, cell) => sum + cell.score.score, 0) / cells.length) * 100) / 100,
      meanRequests: Math.round((cells.reduce((sum, cell) => sum + cell.metrics.requests.length, 0) / cells.length) * 100) / 100,
      meanPromptTokens: promptTokens.length
        ? Math.round(promptTokens.reduce((sum, value) => sum + value, 0) / promptTokens.length)
        : null,
    };
  });
  fs.writeFileSync(path.join(outputRoot, 'matrix.json'), `${JSON.stringify(result, null, 2)}\n`);
  fs.writeFileSync(path.join(outputRoot, 'matrix.md'), markdownReport(result));
  return result;
}

module.exports = {
  CONDITIONS,
  RESPONSE_SCHEMA,
  buildFeatureContext,
  buildBudgetedEvidence,
  buildPrompt,
  buildRawContext,
  compactFeatureContext,
  compactRawContext,
  runGymMatrix,
  scoreResult,
  validateCode,
};
