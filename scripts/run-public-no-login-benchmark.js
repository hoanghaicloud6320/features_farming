#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { NetworkRecorder } = require('../../requests_recorder/src/recorder');
const { chromium } = require('../../requests_recorder/node_modules/playwright-extra');
const { farmInput } = require('../src/collection');
const {
  CONDITIONS,
  buildBudgetedEvidence,
  buildFeatureContext,
  buildRawContext,
} = require('../src/gym-ab');
const {
  CONTRACT_SCHEMA,
  evaluateSuite,
} = require('./run-contract-matrix');
const {
  generateJsonWithFallback,
  loadApiKeys,
} = require('../src/gemini');

const execFileAsync = promisify(execFile);
const SESSION_COUNT = Number(process.env.PUBLIC_BENCH_SESSIONS || 2);
const ITERATION_COUNT = Number(process.env.PUBLIC_BENCH_ITERATIONS || 3);
const CONTEXT_BUDGET_CHARS = Number(process.env.PUBLIC_BENCH_CONTEXT_BUDGET_CHARS || 32_000);
const GENERATION_SEED = Number(process.env.PUBLIC_BENCH_SEED || 126_071);

const PUBLIC_CONTRACT_SCHEMA = structuredClone(CONTRACT_SCHEMA);
const publicCaseSchema = PUBLIC_CONTRACT_SCHEMA.properties.cases.items;
const publicEndpointSchema = publicCaseSchema.properties.endpoints.items;
publicEndpointSchema.required.push(
  'requestBodyKinds',
  'responseBodyKinds',
  'requestContentTypes',
  'responseContentTypes',
);
Object.assign(publicEndpointSchema.properties, {
  requestBodyKinds: {
    type: 'array',
    items: { type: 'string', enum: ['json', 'form', 'text', 'none', 'unknown'] },
  },
  responseBodyKinds: {
    type: 'array',
    items: {
      type: 'string',
      enum: [
        'json-object', 'json-array', 'json-scalar',
        'text', 'binary', 'empty', 'unknown',
      ],
    },
  },
  requestContentTypes: { type: 'array', items: { type: 'string' } },
  responseContentTypes: { type: 'array', items: { type: 'string' } },
});
publicCaseSchema.required.push('replayProfiles');
publicCaseSchema.properties.replayProfiles = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    required: [
      'endpoint', 'field', 'observedValues',
      'classification', 'parameterize',
    ],
    properties: {
      endpoint: { type: 'string' },
      field: { type: 'string' },
      observedValues: { type: 'array', items: { type: 'string' } },
      classification: {
        type: 'string',
        enum: ['observed-stable', 'observed-variable', 'unknown'],
      },
      parameterize: { type: 'boolean' },
    },
  },
};

const AUTOMATION_SCHEMA = {
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

function round(value, digits = 3) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function timestampId() {
  return new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
}

function validateConfiguration() {
  if (!Number.isInteger(SESSION_COUNT) || SESSION_COUNT < 2 || SESSION_COUNT > 4) {
    throw new Error('PUBLIC_BENCH_SESSIONS must be an integer from 2 to 4');
  }
  if (!Number.isInteger(ITERATION_COUNT) || ITERATION_COUNT < 2 || ITERATION_COUNT > 6) {
    throw new Error('PUBLIC_BENCH_ITERATIONS must be an integer from 2 to 6');
  }
  if (!(CONTEXT_BUDGET_CHARS >= 8_000)) {
    throw new Error('PUBLIC_BENCH_CONTEXT_BUDGET_CHARS must be at least 8000');
  }
}

async function createQuickMock(method, payload) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto('https://mockserver.in/quick', {
      waitUntil: 'networkidle',
      timeout: 60_000,
    });
    await page.locator('#method-select').selectOption(method);
    await page.waitForFunction(() => globalThis.monaco?.editor?.getModels().length);
    await page.evaluate(
      (value) => globalThis.monaco.editor.getModels()[0].setValue(value),
      JSON.stringify(payload, null, 2),
    );
    await page.locator('#generate-btn').click();
    await page.getByText('YOUR MOCK IS LIVE').waitFor({ timeout: 30_000 });
    const text = await page.locator('body').innerText();
    const match = text.match(/https:\/\/mockserver\.in\/m\/[A-Za-z0-9_-]+/);
    if (!match) throw new Error('MockServer did not expose a generated Quick Mock URL');
    return match[0];
  } finally {
    await browser.close();
  }
}

async function provisionRelay() {
  const runId = crypto.randomBytes(6).toString('hex');
  const handoffKey = crypto.randomBytes(12).toString('base64url');
  const openUrl = await createQuickMock('GET', { runId, handoffKey });
  const confirmUrl = await createQuickMock('GET', {
    accepted: true,
    challenge: 'hosted-relay',
  });
  return {
    runId,
    handoffKey,
    openUrl,
    confirmUrl,
    expiresIn: '72 hours',
  };
}

function targetDefinitions(relay) {
  const graphQuery = [
    'query GetReviews($first: Int, $after: String) {',
    '  reviews(first: $first, after: $after) {',
    '    edges { node { rid text rating date } cursor }',
    '    pageInfo { startCursor endCursor hasPreviousPage hasNextPage }',
    '  }',
    '}',
  ].join('\n');
  return [
    {
      id: 'quickmock-relay',
      label: 'MockServer opaque two-step relay',
      origin: 'https://mockserver.in',
      entryUrl: 'https://mockserver.in/',
      pathPrefixes: ['/m/'],
      goal: 'Call an undisclosed two-step relay. Copy runId and handoffKey from the opening response into the query string of the final GET request, then print the final response.',
      truth: [
        {
          method: 'GET',
          path: new URL(relay.openUrl).pathname,
          statuses: [200],
          requestFields: [],
          responseFields: ['runId', 'handoffKey'],
        },
        {
          method: 'GET',
          path: new URL(relay.confirmUrl).pathname,
          statuses: [200],
          requestFields: ['runId', 'handoffKey'],
          responseFields: ['accepted', 'challenge'],
        },
      ],
      executionTruth: {
        representations: [
          {
            method: 'GET',
            path: new URL(relay.openUrl).pathname,
            requestBodyKinds: ['none'],
            responseBodyKinds: ['json-object'],
            responseContentTypes: ['application/json'],
          },
          {
            method: 'GET',
            path: new URL(relay.confirmUrl).pathname,
            requestBodyKinds: ['none'],
            responseBodyKinds: ['json-object'],
            responseContentTypes: ['application/json'],
          },
        ],
        replayProfiles: [],
        flows: [{
          from: 'response.body.json$.runId,response.body.json$.handoffKey',
          to: 'request.url.query$query.runId,request.url.query$query.handoffKey',
        }],
        repeatedCalls: [],
      },
      async exercise(page) {
        return page.evaluate(async ({ openUrl, confirmUrl }) => {
          const openResponse = await fetch(openUrl);
          const openText = await openResponse.text();
          if (!openResponse.ok) {
            throw new Error(`Relay open failed: ${openResponse.status} ${openText.slice(0, 120)}`);
          }
          const opening = JSON.parse(openText);
          const finalUrl = new URL(confirmUrl);
          finalUrl.searchParams.set('runId', opening.runId);
          finalUrl.searchParams.set('handoffKey', opening.handoffKey);
          const response = await fetch(finalUrl);
          const responseText = await response.text();
          if (!response.ok) {
            throw new Error(`Relay confirm failed: ${response.status} ${responseText.slice(0, 120)}`);
          }
          return {
            result: JSON.parse(responseText),
            opening,
          };
        }, relay);
      },
      scoreAutomation(result, oracle, audit) {
        const finalRequest = audit.find((request) => {
          if (request.method !== 'GET') return false;
          const url = new URL(request.url);
          return `${url.origin}${url.pathname}` === relay.confirmUrl;
        });
        let query = null;
        try {
          query = new URL(finalRequest.url).searchParams;
        } catch {
          query = null;
        }
        return {
          accepted: (
            result?.accepted === true
            && result?.challenge === 'hosted-relay'
            && query?.get('runId') === relay.runId
            && query?.get('handoffKey') === relay.handoffKey
          ),
          checks: {
            finalResponse: result?.accepted === true,
            copiedRunId: query?.get('runId') === relay.runId,
            copiedHandoffKey: query?.get('handoffKey') === relay.handoffKey,
          },
        };
      },
    },
    {
      id: 'tryscrapeme-ajax',
      label: 'TryScrapeMe AJAX books',
      origin: 'https://tryscrapeme.com',
      entryUrl: 'https://tryscrapeme.com/web-scraping-practice/beginner/ajax',
      pathPrefixes: ['/web-scraping-practice/beginner/ajax'],
      goal: 'Use the AJAX data behind the entry page. Print exactly {"itemCount":<count>,"totalPrice":<sum of every numeric price rounded to two decimals>}.',
      truth: [{
        method: 'GET',
        path: '/web-scraping-practice/beginner/ajax/api',
        statuses: [200],
        requestFields: [],
        responseFields: [
          'id', 'name', 'author', 'format', 'stars', 'price',
          'old_price', 'isbn', 'category', 'cover',
        ],
      }],
      executionTruth: {
        representations: [{
          method: 'GET',
          path: '/web-scraping-practice/beginner/ajax/api',
          requestBodyKinds: ['none'],
          responseBodyKinds: ['json-array'],
          responseContentTypes: ['text/plain'],
        }],
        replayProfiles: [],
        flows: [],
        repeatedCalls: [],
      },
      async exercise(page) {
        return page.evaluate(async () => {
          const items = await (
            await fetch('/web-scraping-practice/beginner/ajax/api')
          ).json();
          return {
            itemCount: items.length,
            totalPrice: Math.round(
              items.reduce((sum, item) => sum + Number(item.price), 0) * 100,
            ) / 100,
          };
        });
      },
      scoreAutomation(result, oracle) {
        return {
          accepted: (
            result?.itemCount === oracle.itemCount
            && Math.abs(Number(result?.totalPrice) - oracle.totalPrice) < 0.001
          ),
          checks: {
            itemCount: result?.itemCount === oracle.itemCount,
            totalPrice: Math.abs(Number(result?.totalPrice) - oracle.totalPrice) < 0.001,
          },
        };
      },
    },
    {
      id: 'webscraping-graphql',
      label: 'web-scraping.dev GraphQL pagination',
      origin: 'https://web-scraping.dev',
      minRequestIntervalMs: 2100,
      entryUrl: 'https://web-scraping.dev/reviews',
      pathPrefixes: ['/api/graphql'],
      goal: 'Fetch the first two GraphQL review pages using the cursor returned by page one. Print exactly {"reviewCount":<combined count>,"ratingSum":<combined sum>,"endCursor":<second page endCursor>}.',
      truth: [{
        method: 'POST',
        path: '/api/graphql',
        statuses: [200],
        requestFields: ['query', 'variables.first', 'variables.after'],
        responseFields: [
          'data.reviews.edges[].node.rid',
          'data.reviews.edges[].node.text',
          'data.reviews.edges[].node.rating',
          'data.reviews.edges[].node.date',
          'data.reviews.edges[].cursor',
          'data.reviews.pageInfo.startCursor',
          'data.reviews.pageInfo.endCursor',
          'data.reviews.pageInfo.hasPreviousPage',
          'data.reviews.pageInfo.hasNextPage',
        ],
      }],
      executionTruth: {
        representations: [{
          method: 'POST',
          path: '/api/graphql',
          requestBodyKinds: ['json'],
          responseBodyKinds: ['json-object'],
          responseContentTypes: ['application/json'],
        }],
        replayProfiles: [{
          endpoint: 'POST /api/graphql',
          field: 'body.json$.variables.first',
          observedValues: ['20'],
        }],
        flows: [{
          from: 'response.body.json$.data.reviews.pageInfo.endCursor',
          to: 'request.body.json$.variables.after',
        }],
        repeatedCalls: [{ endpoint: 'POST /api/graphql', count: 2 }],
      },
      async exercise(page) {
        return page.evaluate(async (query) => {
          const request = async (after) => (
            await (
              await fetch('/api/graphql', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  query,
                  variables: { first: 20, after },
                }),
              })
            ).json()
          ).data.reviews;
          await new Promise((resolve) => setTimeout(resolve, 2100));
          const first = await request('');
          await new Promise((resolve) => setTimeout(resolve, 2100));
          const second = await request(first.pageInfo.endCursor);
          const nodes = [...first.edges, ...second.edges].map((edge) => edge.node);
          return {
            reviewCount: nodes.length,
            ratingSum: nodes.reduce((sum, node) => sum + node.rating, 0),
            endCursor: second.pageInfo.endCursor,
          };
        }, graphQuery);
      },
      scoreAutomation(result, oracle) {
        return {
          accepted: (
            result?.reviewCount === oracle.reviewCount
            && result?.ratingSum === oracle.ratingSum
            && result?.endCursor === oracle.endCursor
          ),
          checks: {
            reviewCount: result?.reviewCount === oracle.reviewCount,
            ratingSum: result?.ratingSum === oracle.ratingSum,
            cursorFlow: result?.endCursor === oracle.endCursor,
          },
        };
      },
    },
    {
      id: 'testpages-calculator',
      label: 'TestPages internal calculator API',
      origin: 'https://testpages.eviltester.com',
      entryUrl: 'https://testpages.eviltester.com/apps/server-side-calculator/',
      pathPrefixes: ['/internalapi/simple-calculator'],
      goal: 'Use the entry page server API to calculate, in order: 17 times 23, 144 divide 12, and 91 minus 37. Print {"values":["391","12","54"]}.',
      truth: [{
        method: 'POST',
        path: '/internalapi/simple-calculator',
        statuses: [200],
        requestFields: ['number1', 'function', 'number2'],
        responseFields: [],
      }],
      executionTruth: {
        representations: [{
          method: 'POST',
          path: '/internalapi/simple-calculator',
          requestBodyKinds: ['form'],
          responseBodyKinds: ['json-scalar'],
          responseContentTypes: ['text/html'],
        }],
        replayProfiles: [
          {
            endpoint: 'POST /internalapi/simple-calculator',
            field: 'body.form$.function',
            observedValues: ['times', 'divide', 'minus'],
          },
        ],
        flows: [],
        repeatedCalls: [{
          endpoint: 'POST /internalapi/simple-calculator',
          count: 3,
        }],
      },
      async exercise(page, iteration) {
        return page.evaluate(async (offset) => {
          const calculations = [
            { number1: 17 + offset, function: 'times', number2: 23 },
            { number1: 144 + (offset * 12), function: 'divide', number2: 12 },
            { number1: 91 + offset, function: 'minus', number2: 37 },
          ];
          const values = [];
          for (const calculation of calculations) {
            const response = await fetch('/internalapi/simple-calculator', {
              method: 'POST',
              headers: { 'content-type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams(calculation),
            });
            values.push(await response.text());
          }
          return { values };
        }, iteration);
      },
      fixedOracle: { values: ['391', '12', '54'] },
      scoreAutomation(result) {
        return {
          accepted: JSON.stringify(result?.values) === JSON.stringify(['391', '12', '54']),
          checks: {
            allCalculations: JSON.stringify(result?.values) === JSON.stringify(['391', '12', '54']),
          },
        };
      },
    },
    {
      id: 'testpages-products',
      label: 'TestPages product count/list/detail',
      origin: 'https://testpages.eviltester.com',
      entryUrl: 'https://testpages.eviltester.com/apps/basiccart/',
      pathPrefixes: ['/api/basicstore/products'],
      goal: 'Use the anonymous product API: get the total count, request four products, then fetch details for the first listed product. Print count, selectedId, selectedTitle, and detailTitleMatches.',
      truth: [
        {
          method: 'GET',
          path: '/api/basicstore/products/count',
          statuses: [200],
          requestFields: [],
          responseFields: [],
        },
        {
          method: 'GET',
          path: '/api/basicstore/products',
          statuses: [200],
          requestFields: ['query.from', 'query.to', 'query.limit'],
          responseFields: [
            'id', 'price', 'title', 'description', 'stockLevel', 'thumbnail',
          ],
        },
        {
          method: 'GET',
          path: '/api/basicstore/products/:id',
          statuses: [200],
          requestFields: ['path.id'],
          responseFields: [
            'id', 'price', 'title', 'description', 'content', 'stockLevel', 'thumbnail',
          ],
        },
      ],
      executionTruth: {
        representations: [
          {
            method: 'GET',
            path: '/api/basicstore/products/count',
            requestBodyKinds: ['none'],
            responseBodyKinds: ['json-scalar'],
          },
          {
            method: 'GET',
            path: '/api/basicstore/products',
            requestBodyKinds: ['none'],
            responseBodyKinds: ['json-array'],
          },
          {
            method: 'GET',
            path: '/api/basicstore/products/:id',
            requestBodyKinds: ['none'],
            responseBodyKinds: ['json-object'],
          },
        ],
        replayProfiles: [{
          endpoint: 'GET /api/basicstore/products',
          field: 'url.query$query.limit',
          observedValues: ['4'],
        }],
        flows: [{
          from: 'response.body.json$[].id',
          to: 'request.url.path$path.id',
        }],
        repeatedCalls: [],
      },
      async exercise(page, iteration) {
        return page.evaluate(async (offset) => {
          const count = Number(await (
            await fetch('/api/basicstore/products/count')
          ).text());
          const products = await (
            await fetch(`/api/basicstore/products?from=${offset}&to=${offset + 4}&limit=4`)
          ).json();
          const selected = products[0];
          const detail = await (
            await fetch(`/api/basicstore/products/${selected.id}`)
          ).json();
          return {
            count,
            selectedId: selected.id,
            selectedTitle: selected.title,
            detailTitleMatches: detail.title === selected.title,
          };
        }, iteration);
      },
      scoreAutomation(result, oracle) {
        return {
          accepted: (
            result?.count === oracle.count
            && result?.selectedId === oracle.selectedId
            && result?.selectedTitle === oracle.selectedTitle
            && result?.detailTitleMatches === true
          ),
          checks: {
            count: result?.count === oracle.count,
            selectedId: result?.selectedId === oracle.selectedId,
            selectedTitle: result?.selectedTitle === oracle.selectedTitle,
            detailTitleMatches: result?.detailTitleMatches === true,
          },
        };
      },
    },
  ];
}

async function collectTarget(definition, recordingRoot) {
  const oracles = [];
  for (let sessionNumber = 1; sessionNumber <= SESSION_COUNT; sessionNumber += 1) {
    const recorder = new NetworkRecorder({
      outputRoot: recordingRoot,
      startUrl: definition.entryUrl,
      headless: true,
      showControls: false,
      captureBodies: true,
      maxBodyBytes: 1024 * 1024,
      iterationQuietMs: Math.max(
        250,
        Number(definition.minRequestIntervalMs || 0) + 500,
      ),
      iterationMinMs: 0,
      iterationMaxMs: 20_000,
    });
    try {
      const { page } = await recorder.start();
      await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(500);
      for (let iteration = 0; iteration < ITERATION_COUNT; iteration += 1) {
        await recorder.startIteration(`${definition.id}-s${sessionNumber}`);
        const result = await definition.exercise(page, iteration);
        oracles.push(result?.result || result);
        await recorder.endIteration(`${definition.id}-iteration-complete`);
      }
      await recorder.stop(`${definition.id}-complete`);
    } catch (error) {
      await recorder.stop(`${definition.id}-error`);
      throw error;
    }
    console.log(`${definition.id}: recorded session ${sessionNumber}/${SESSION_COUNT}`);
  }
  return definition.fixedOracle || oracles[0];
}

function buildContractPrompt(definition, condition, evidence) {
  return [
    'Generate an observed API contract from controlled browser-traffic evidence.',
    'The contract is the only primary output. Do not generate automation code.',
    'Use supplied evidence plus any site-specific knowledge already present in your model.',
    'You have no browser, tools, documentation, or source code. Do not assume conventional routes.',
    'Return the required caseId exactly once.',
    'With no evidence and no genuine prior knowledge, return an empty endpoint list and state uncertainty.',
    'Farmed contractInventory is authoritative concrete attribution.',
    'Keep API shape separate from executable replay evidence.',
    'For every endpoint, report observed request/response body kinds and media types; use unknown when evidence is absent.',
    'Put passive literal observations in replayProfiles. Mark them parameterized; an observed stable value is not proof that the API requires hardcoding it.',
    'Preserve repeated calls to the same endpoint as distinct workflow steps and distinguish candidate traces from confirmed data flows.',
    `Case ID: ${definition.id}`,
    `Target origin: ${definition.origin}`,
    `Entry page: ${definition.entryUrl}`,
    `Functional goal: ${definition.goal}`,
    `Evidence arm: ${condition.label}`,
    '',
    'EVIDENCE JSON:',
    JSON.stringify(evidence),
  ].join('\n');
}

function buildAutomationPrompt(definition, condition, evidence) {
  return [
    'Generate one CommonJS Node.js 20+ HTTP automation script.',
    'Use only built-in fetch and optionally node:assert/strict or node:crypto.',
    'Do not use a browser, external packages, shell commands, files, environment variables, or documentation.',
    `Only send requests to ${definition.origin}.`,
    'Make no more than 8 HTTP requests.',
    'At runtime, stdout must end with one machine-readable line produced by:',
    "console.log('RESULT_JSON:' + JSON.stringify(result));",
    'Here result is only the requested result object (not assessment metadata).',
    'The RESULT_JSON marker must stay inside the JavaScript string literal; never append it as bare source text.',
    'Do not wrap the code in Markdown fences.',
    'Use supplied evidence plus any site-specific knowledge already present in your model.',
    'You have no browser, tools, documentation, or source code while generating the script.',
    'When evidence is absent and you do not genuinely know a route, do not present a guess as fact.',
    `Target origin: ${definition.origin}`,
    `Entry page: ${definition.entryUrl}`,
    `Goal: ${definition.goal}`,
    `Evidence arm: ${condition.label}`,
    '',
    'EVIDENCE JSON:',
    JSON.stringify(evidence),
  ].join('\n');
}

function validateAutomationCode(code, origin) {
  if (typeof code !== 'string' || code.length < 20) throw new Error('Generated code is empty');
  if (code.length > 50_000) throw new Error('Generated code is too large');
  const forbidden = [
    /child_process/i,
    /node:fs|require\(['"]fs['"]\)/i,
    /node:net|node:tls|node:dns/i,
    /process\.env/i,
    /\beval\s*\(|new\s+Function/i,
    /\bimport\s*\(/i,
    /WebSocket/i,
  ];
  for (const pattern of forbidden) {
    if (pattern.test(code)) throw new Error(`Generated code uses forbidden capability: ${pattern}`);
  }
  const imports = [...code.matchAll(/require\((['"])(.*?)\1\)/g)].map((match) => match[2]);
  const allowedImports = new Set(['node:assert/strict', 'node:crypto']);
  if (imports.some((name) => !allowedImports.has(name))) {
    throw new Error(`Generated code imports a forbidden module: ${imports.join(', ')}`);
  }
  const urls = [...code.matchAll(/https?:\/\/[^\s'"`\\)]+/g)].map((match) => match[0]);
  if (urls.some((url) => !url.startsWith(origin))) {
    throw new Error(`Generated code contains a foreign URL: ${urls.join(', ')}`);
  }
}

function bootstrapSource(origin, candidateFile, minRequestIntervalMs = 0) {
  return [
    "'use strict';",
    `const allowedOrigin = ${JSON.stringify(origin)};`,
    `const candidateFile = ${JSON.stringify(candidateFile)};`,
    'const originalFetch = global.fetch;',
    'const audit = [];',
    'let lastRequestAt = 0;',
    'global.fetch = async (input, init = {}) => {',
    "  const inputUrl = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);",
    '  const url = new URL(inputUrl, allowedOrigin);',
    "  if (url.origin !== allowedOrigin) throw new Error(`Foreign origin blocked: ${url.origin}`);",
    "  if (audit.length >= 8) throw new Error('HTTP request budget exceeded');",
    "  const method = String(init.method || (typeof input !== 'string' && input.method) || 'GET').toUpperCase();",
    `  const waitMs = Math.max(0, ${Number(minRequestIntervalMs)} - (Date.now() - lastRequestAt));`,
    '  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));',
    '  lastRequestAt = Date.now();',
    '  audit.push({ url: url.href, method, body: init.body == null ? null : String(init.body) });',
    '  return originalFetch(input, init);',
    '};',
    "process.on('exit', () => console.log(`FETCH_AUDIT_JSON:${JSON.stringify(audit)}`));",
    'require(candidateFile);',
  ].join('\n');
}

function parseMarker(stdout, marker) {
  const line = stdout.split(/\r?\n/).filter((item) => item.startsWith(marker)).at(-1);
  if (!line) return null;
  return JSON.parse(line.slice(marker.length));
}

async function executeAutomation(code, definition, runRoot) {
  const candidateFile = path.join(runRoot, 'automation.js');
  const bootstrapFile = path.join(runRoot, 'execute.js');
  fs.writeFileSync(candidateFile, `${code}\n`);
  fs.writeFileSync(
    bootstrapFile,
    `${bootstrapSource(
      definition.origin,
      candidateFile,
      definition.minRequestIntervalMs,
    )}\n`,
  );
  validateAutomationCode(code, definition.origin);
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [bootstrapFile], {
      cwd: runRoot,
      timeout: 45_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    });
    return {
      exitCode: 0,
      stdout,
      stderr,
      result: parseMarker(stdout, 'RESULT_JSON:'),
      audit: parseMarker(stdout, 'FETCH_AUDIT_JSON:') || [],
    };
  } catch (error) {
    return {
      exitCode: error.code || 1,
      stdout: error.stdout || '',
      stderr: error.stderr || error.message,
      result: null,
      audit: parseMarker(error.stdout || '', 'FETCH_AUDIT_JSON:') || [],
    };
  }
}

function literalRouteMatches(definition, contract, code) {
  const expectedPaths = definition.truth.map((endpoint) => endpoint.path);
  const contractText = JSON.stringify(contract || {});
  const matches = [];
  for (const expectedPath of expectedPaths) {
    const stablePrefix = expectedPath.replace(/\/:[^/]+.*$/, '');
    if (
      contractText.includes(expectedPath)
      || code.includes(expectedPath)
      || (stablePrefix.length > 8 && code.includes(stablePrefix))
    ) {
      matches.push(expectedPath);
    }
  }
  return [...new Set(matches)];
}

function normalizeObservedPath(value) {
  return String(value || '')
    .split('?', 1)[0]
    .replace(/\/\d+(?=\/|$)/g, '/:param')
    .replace(/\{[^/}]+\}|:[^/]+/g, ':param')
    .replace(/\/+$/, '') || '/';
}

function publicEndpointKey(endpoint) {
  return `${String(endpoint.method || 'GET').toUpperCase()} ${normalizeObservedPath(endpoint.path)}`;
}

function readinessToken(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function endpointReferenceKey(value, fallbackMethod = 'GET') {
  const text = String(value || '').trim();
  const match = text.match(/^([A-Z]+)\s+(.+)$/i);
  return publicEndpointKey({
    method: match ? match[1] : fallbackMethod,
    path: match ? match[2] : text,
  });
}

function evaluateExecutableReadiness(definition, contract) {
  const contractCase = (contract.cases || []).find(
    (item) => item.caseId === definition.id,
  ) || { endpoints: [], replayProfiles: [], workflows: [] };
  const endpointMap = new Map(
    (contractCase.endpoints || []).map((endpoint) => [
      publicEndpointKey(endpoint),
      endpoint,
    ]),
  );
  const representationChecks = [];
  const representedEndpoints = [];
  for (const expected of definition.executionTruth.representations) {
    const endpoint = endpointMap.get(publicEndpointKey(expected));
    representedEndpoints.push(Boolean(endpoint));
    representationChecks.push(
      expected.requestBodyKinds.some(
        (kind) => (endpoint?.requestBodyKinds || []).includes(kind),
      ),
      expected.responseBodyKinds.some(
        (kind) => (endpoint?.responseBodyKinds || []).includes(kind),
      ),
    );
    if (expected.responseContentTypes?.length) {
      representationChecks.push(expected.responseContentTypes.some(
        (contentType) => (endpoint?.responseContentTypes || []).some(
          (claimed) => claimed.toLowerCase().startsWith(contentType),
        ),
      ));
    }
  }

  const replayChecks = definition.executionTruth.replayProfiles.map((expected) => {
    const expectedMethod = String(expected.endpoint).split(/\s+/, 1)[0];
    const profile = (contractCase.replayProfiles || []).find((candidate) => (
      endpointReferenceKey(candidate.endpoint, expectedMethod)
      === endpointReferenceKey(expected.endpoint, expectedMethod)
      && (
        readinessToken(candidate.field) === readinessToken(expected.field)
        || (
          readinessToken(candidate.field).length >= 3
          && readinessToken(expected.field).endsWith(readinessToken(candidate.field))
        )
      )
    ));
    if (!profile) return 0;
    const claimedValues = new Set(
      (profile.observedValues || []).map((value) => String(value)),
    );
    const valueRecall = expected.observedValues.filter(
      (value) => claimedValues.has(String(value)),
    ).length / Math.max(expected.observedValues.length, 1);
    return 0.5 + (0.5 * valueRecall);
  });

  const workflowText = JSON.stringify(contractCase.workflows || []).toLowerCase();
  const flowChecks = definition.executionTruth.flows.map((flow) => {
    const tokens = [...new Set(
      `${flow.from},${flow.to}`
        .split(',')
        .map((item) => item.split('.').at(-1))
        .map(readinessToken)
        .filter((token) => token.length >= 3),
    )];
    const normalizedWorkflow = readinessToken(workflowText);
    return tokens.every((token) => normalizedWorkflow.includes(token));
  });
  const repeatedChecks = definition.executionTruth.repeatedCalls.map((expected) => {
    const endpoint = expected.endpoint.toLowerCase();
    const steps = (contractCase.workflows || []).flatMap(
      (workflow) => workflow.steps || [],
    );
    return steps.filter((step) => String(step).toLowerCase().includes(endpoint)).length
      >= expected.count;
  });

  const meanBoolean = (checks) => (
    checks.length
      ? checks.reduce((sum, value) => sum + Number(value), 0) / checks.length
      : 1
  );
  const meanNumber = (checks) => (
    checks.length
      ? checks.reduce((sum, value) => sum + value, 0) / checks.length
      : 1
  );
  const metrics = {
    endpointCoverage: round(meanBoolean(representedEndpoints)),
    representationAccuracy: round(meanBoolean(representationChecks)),
    replayAccuracy: round(meanNumber(replayChecks)),
    flowAccuracy: round(meanBoolean(flowChecks)),
    repeatedWorkflowAccuracy: round(meanBoolean(repeatedChecks)),
  };
  const weightedComponents = [
    {
      applicable: definition.executionTruth.representations.length > 0,
      weight: 0.5,
      value: metrics.representationAccuracy,
    },
    {
      applicable: definition.executionTruth.replayProfiles.length > 0,
      weight: 0.2,
      value: metrics.replayAccuracy,
    },
    {
      applicable: definition.executionTruth.flows.length > 0,
      weight: 0.2,
      value: metrics.flowAccuracy,
    },
    {
      applicable: definition.executionTruth.repeatedCalls.length > 0,
      weight: 0.1,
      value: metrics.repeatedWorkflowAccuracy,
    },
  ].filter((item) => item.applicable);
  const applicableWeight = weightedComponents.reduce(
    (sum, item) => sum + item.weight,
    0,
  );
  return {
    ...metrics,
    score: round(
      100 * metrics.endpointCoverage * weightedComponents.reduce(
        (sum, item) => sum + (item.weight * item.value),
        0,
      ) / (applicableWeight || 1),
      2,
    ),
  };
}

function addSemanticAutomationScore(definition, result, oracle, exactScore) {
  let semanticAccepted = exactScore.accepted;
  if (definition.id === 'tryscrapeme-ajax') {
    const count = result?.itemCount ?? result?.count;
    const total = result?.totalPrice ?? result?.totalSum ?? result?.sum;
    semanticAccepted = (
      count === oracle.itemCount
      && Math.abs(Number(total) - oracle.totalPrice) < 0.001
    );
  } else if (definition.id === 'webscraping-graphql') {
    const cursor = result?.endCursor ?? result?.secondPageEndCursor;
    semanticAccepted = (
      result?.reviewCount === oracle.reviewCount
      && result?.ratingSum === oracle.ratingSum
      && cursor === oracle.endCursor
    );
  } else if (definition.id === 'testpages-calculator') {
    semanticAccepted = (
      Array.isArray(result?.values)
      && JSON.stringify(result.values.map(String)) === JSON.stringify(['391', '12', '54'])
    );
  }
  return {
    ...exactScore,
    accepted: exactScore.accepted,
    exactAccepted: exactScore.accepted,
    semanticAccepted,
  };
}

function aggregateRuns(runs, arm) {
  const selected = runs.filter((run) => run.arm === arm);
  const count = Math.max(selected.length, 1);
  const contractPromptTokens = selected.reduce(
    (sum, run) => sum + run.contract.promptTokens,
    0,
  );
  const automationPromptTokens = selected.reduce(
    (sum, run) => sum + run.automation.promptTokens,
    0,
  );
  const meanContractQuality = selected.reduce(
    (sum, run) => sum + run.contract.evaluation.qualityScore,
    0,
  ) / count;
  const exactAutomationPasses = selected.filter(
    (run) => run.automation.score.exactAccepted ?? run.automation.score.accepted,
  ).length;
  const semanticAutomationPasses = selected.filter(
    (run) => run.automation.score.semanticAccepted ?? run.automation.score.accepted,
  ).length;
  return {
    arm,
    targets: selected.length,
    meanContractQuality: round(meanContractQuality, 2),
    meanExecutableReadiness: round(
      selected.reduce(
        (sum, run) => sum + (run.contract.executableReadiness?.score || 0),
        0,
      ) / count,
      2,
    ),
    meanEndpointF1: round(
      selected.reduce((sum, run) => sum + run.contract.evaluation.endpointF1, 0)
      / count,
    ),
    exactStatusAccuracy: round(
      selected.reduce(
        (sum, run) => sum + run.contract.evaluation.exactStatusAccuracy,
        0,
      ) / count,
    ),
    automationPassRate: round(exactAutomationPasses / count),
    exactAutomationPassRate: round(exactAutomationPasses / count),
    semanticAutomationPassRate: round(semanticAutomationPasses / count),
    contractPromptTokens,
    automationPromptTokens,
    promptTokens: contractPromptTokens + automationPromptTokens,
    meanPromptTokensPerTarget: round(
      (contractPromptTokens + automationPromptTokens) / count,
      1,
    ),
    contractQualityPer1kPromptTokens: round(
      contractPromptTokens
        ? (meanContractQuality * 1000 * selected.length) / contractPromptTokens
        : 0,
      2,
    ),
  };
}

function addAggregates(result) {
  const cleanTargetIds = new Set(
    result.targets
      .filter((target) => !target.noEvidence.contaminated)
      .map((target) => target.id),
  );
  result.cleanTargetIds = [...cleanTargetIds];
  result.aggregates = CONDITIONS.map((condition) => (
    aggregateRuns(result.runs, condition.id)
  ));
  result.cleanAggregates = CONDITIONS.map((condition) => (
    aggregateRuns(
      result.runs.filter((run) => cleanTargetIds.has(run.target)),
      condition.id,
    )
  ));
}

function markdownReport(result) {
  const lines = [
    '# Public no-login contract and automation benchmark',
    '',
    `Model: \`${result.model}\``,
    '',
    '| Target | Arm | Contract quality | Executable readiness | Endpoint F1 | Exact statuses | Automation semantic | Output exact | Prompt tokens |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const run of result.runs) {
    lines.push(
      `| ${run.target} | ${run.arm} | ${run.contract.evaluation.qualityScore.toFixed(2)} `
      + `| ${(run.contract.executableReadiness?.score ?? 0).toFixed(2)} `
      + `| ${(run.contract.evaluation.endpointF1 * 100).toFixed(1)}% `
      + `| ${(run.contract.evaluation.exactStatusAccuracy * 100).toFixed(1)}% `
      + `| ${(run.automation.score.semanticAccepted ?? run.automation.score.accepted) ? 'PASS' : 'FAIL'} `
      + `| ${(run.automation.score.exactAccepted ?? run.automation.score.accepted) ? 'PASS' : 'FAIL'} `
      + `| ${run.contract.promptTokens + run.automation.promptTokens} |`,
    );
  }
  lines.push('', '## Clean-target summary', '');
  lines.push(
    '| Arm | Contract quality | Executable readiness | Endpoint F1 | Exact statuses | Automation semantic | Output exact | Tokens / target | Contract quality / 1k contract tokens |',
  );
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const aggregate of result.cleanAggregates) {
    lines.push(
      `| ${aggregate.arm} | ${aggregate.meanContractQuality.toFixed(2)} `
      + `| ${aggregate.meanExecutableReadiness.toFixed(2)} `
      + `| ${(aggregate.meanEndpointF1 * 100).toFixed(1)}% `
      + `| ${(aggregate.exactStatusAccuracy * 100).toFixed(1)}% `
      + `| ${(aggregate.semanticAutomationPassRate * 100).toFixed(1)}% `
      + `| ${(aggregate.exactAutomationPassRate * 100).toFixed(1)}% `
      + `| ${aggregate.meanPromptTokensPerTarget.toFixed(1)} `
      + `| ${aggregate.contractQualityPer1kPromptTokens.toFixed(2)} |`,
    );
  }
  lines.push('', '## No-evidence contamination gate', '');
  lines.push('| Target | Contract route recall | Static route matches | Automation accepted | Gate |');
  lines.push('|---|---:|---:|---:|---|');
  for (const target of result.targets) {
    lines.push(
      `| ${target.id} | ${(target.noEvidence.contractEndpointRecall * 100).toFixed(1)}% `
      + `| ${target.noEvidence.literalRouteMatches.length} `
      + `| ${target.noEvidence.automationAccepted ? 'yes' : 'no'} `
      + `| ${target.noEvidence.contaminated ? 'CONTAMINATED' : 'CLEAN'} |`,
    );
  }
  lines.push(
    '',
    'A target is marked contaminated when the no-evidence contract or generated source contains an exact/stable internal route. Runtime discovery is reported separately from static prior-knowledge matches.',
    'Contaminated targets are quarantined from the clean-target summary.',
    '',
    'One fixed-seed trial is used per cell. This is a live diagnostic matrix, not a statistically powered benchmark.',
    '',
  );
  return lines.join('\n');
}

function refreshExistingEvaluations(outputRoot) {
  const matrixFile = path.join(outputRoot, 'matrix.json');
  const existing = JSON.parse(fs.readFileSync(matrixFile, 'utf8'));
  const quickContractFile = path.join(
    outputRoot,
    'quickmock-relay',
    'raw',
    'contract.json',
  );
  const quickPaths = fs.existsSync(quickContractFile)
    ? JSON.parse(fs.readFileSync(quickContractFile, 'utf8')).cases
      .find((item) => item.caseId === 'quickmock-relay')
      ?.endpoints.map((endpoint) => endpoint.path) || []
    : [];
  const definitions = targetDefinitions({
    runId: 'reevaluation',
    handoffKey: 'reevaluation',
    openUrl: `https://mockserver.in${quickPaths[0] || '/m/open'}`,
    confirmUrl: `https://mockserver.in${quickPaths[1] || '/m/confirm'}`,
    expiresIn: 'unknown',
  });
  const definitionsById = new Map(
    definitions.map((definition) => [definition.id, definition]),
  );
  for (const run of existing.runs) {
    const definition = definitionsById.get(run.target);
    const contract = JSON.parse(fs.readFileSync(
      path.join(outputRoot, run.target, run.arm, 'contract.json'),
      'utf8',
    ));
    run.contract.executableReadiness = evaluateExecutableReadiness(
      definition,
      contract,
    );
  }
  for (const target of existing.targets) {
    target.executionTruth = definitionsById.get(target.id)?.executionTruth;
  }
  existing.schemaVersion = 2;
  addAggregates(existing);
  fs.writeFileSync(matrixFile, `${JSON.stringify(existing, null, 2)}\n`);
  fs.writeFileSync(
    path.join(outputRoot, 'matrix.md'),
    `${markdownReport(existing)}\n`,
  );
}

async function main() {
  validateConfiguration();
  const workspace = path.resolve(__dirname, '..');
  const runId = timestampId();
  const recordingBase = process.env.PUBLIC_BENCH_DATA_ROOT
    ? path.resolve(process.env.PUBLIC_BENCH_DATA_ROOT)
    : path.join(workspace, 'demo-data', 'public-no-login', runId);
  const farmBase = process.env.PUBLIC_BENCH_FARM_ROOT
    ? path.resolve(process.env.PUBLIC_BENCH_FARM_ROOT)
    : path.join(workspace, 'output', 'public-no-login', runId);
  const outputRoot = process.env.PUBLIC_BENCH_OUTPUT
    ? path.resolve(process.env.PUBLIC_BENCH_OUTPUT)
    : path.join(workspace, 'generated', 'public-no-login-benchmark');
  fs.mkdirSync(recordingBase, { recursive: true });
  fs.mkdirSync(farmBase, { recursive: true });
  fs.mkdirSync(outputRoot, { recursive: true });

  if (process.env.PUBLIC_BENCH_REPORT_ONLY === '1') {
    const matrixFile = path.join(outputRoot, 'matrix.json');
    const existing = JSON.parse(fs.readFileSync(matrixFile, 'utf8'));
    addAggregates(existing);
    fs.writeFileSync(matrixFile, `${JSON.stringify(existing, null, 2)}\n`);
    fs.writeFileSync(path.join(outputRoot, 'matrix.md'), `${markdownReport(existing)}\n`);
    console.log(`Public benchmark report refreshed: ${path.join(outputRoot, 'matrix.md')}`);
    return;
  }
  if (process.env.PUBLIC_BENCH_REEVALUATE_EXISTING === '1') {
    refreshExistingEvaluations(outputRoot);
    console.log(`Public benchmark reevaluated: ${path.join(outputRoot, 'matrix.md')}`);
    return;
  }

  console.log('Provisioning two no-login opaque Quick Mocks...');
  const relay = await provisionRelay();
  const allDefinitions = targetDefinitions(relay);
  const selected = process.env.PUBLIC_BENCH_TARGETS
    ? new Set(process.env.PUBLIC_BENCH_TARGETS.split(',').map((value) => value.trim()).filter(Boolean))
    : null;
  const definitions = allDefinitions.filter((definition) => !selected || selected.has(definition.id));
  if (!definitions.length) throw new Error('No public benchmark targets selected');

  const prepared = [];
  for (const definition of definitions) {
    const recordingRoot = path.join(recordingBase, definition.id);
    const farmRoot = path.join(farmBase, definition.id);
    const oracle = await collectTarget(definition, recordingRoot);
    await farmInput({ inputDirectory: recordingRoot, outputDirectory: farmRoot });
    const raw = buildRawContext(recordingRoot, { pathPrefixes: definition.pathPrefixes });
    const features = buildFeatureContext(farmRoot);
    prepared.push({ definition, oracle, raw, features });
    console.log(`${definition.id}: evidence ready`);
  }

  const apiKeys = loadApiKeys(path.join(workspace, 'gemini-api-key.txt'));
  const result = {
    schemaVersion: 2,
    benchmark: 'public-no-login-contract-automation',
    generatedAt: new Date().toISOString(),
    model: null,
    generationSeed: GENERATION_SEED,
    sessions: SESSION_COUNT,
    iterationsPerSession: ITERATION_COUNT,
    contextBudgetChars: CONTEXT_BUDGET_CHARS,
    relay: {
      origin: 'https://mockserver.in',
      expiresIn: relay.expiresIn,
      provisionedAt: new Date().toISOString(),
    },
    targets: [],
    runs: [],
  };

  for (const item of prepared) {
    const { definition, oracle, raw, features } = item;
    const targetResult = {
      id: definition.id,
      label: definition.label,
      origin: definition.origin,
      entryUrl: definition.entryUrl,
      executionTruth: definition.executionTruth,
      caseCount: 1,
      noEvidence: null,
    };
    for (const condition of CONDITIONS) {
      const evidence = buildBudgetedEvidence({
        condition,
        raw,
        features,
        budgetChars: CONTEXT_BUDGET_CHARS,
      });
      const contractGenerated = await generateJsonWithFallback({
        apiKeys,
        prompt: buildContractPrompt(definition, condition, evidence),
        responseJsonSchema: PUBLIC_CONTRACT_SCHEMA,
        maxOutputTokens: 12_000,
        seed: GENERATION_SEED,
      });
      result.model ||= contractGenerated.model;
      const suite = { cases: [{ id: definition.id, truth: definition.truth }] };
      const contractEvaluation = evaluateSuite(suite, contractGenerated.data);
      const executableReadiness = evaluateExecutableReadiness(
        definition,
        contractGenerated.data,
      );

      const automationGenerated = await generateJsonWithFallback({
        apiKeys,
        prompt: buildAutomationPrompt(definition, condition, evidence),
        responseJsonSchema: AUTOMATION_SCHEMA,
        maxOutputTokens: 12_000,
        seed: GENERATION_SEED,
      });
      const runRoot = path.join(outputRoot, definition.id, condition.id);
      fs.mkdirSync(runRoot, { recursive: true });
      const execution = await executeAutomation(
        automationGenerated.data.code,
        definition,
        runRoot,
      ).catch((error) => ({
        exitCode: 1,
        stdout: '',
        stderr: error.message,
        result: null,
        audit: [],
      }));
      const exactAutomationScore = definition.scoreAutomation(
        execution.result,
        oracle,
        execution.audit,
      );
      const automationScore = addSemanticAutomationScore(
        definition,
        execution.result,
        oracle,
        exactAutomationScore,
      );
      const routeMatches = literalRouteMatches(
        definition,
        contractGenerated.data,
        automationGenerated.data.code,
      );
      const run = {
        target: definition.id,
        targetLabel: definition.label,
        arm: condition.id,
        evidenceChars: JSON.stringify(evidence).length,
        contract: {
          promptTokens: contractGenerated.usageMetadata?.promptTokenCount || 0,
          outputTokens: contractGenerated.usageMetadata?.candidatesTokenCount || 0,
          evaluation: contractEvaluation,
          executableReadiness,
          responseId: contractGenerated.responseId,
        },
        automation: {
          promptTokens: automationGenerated.usageMetadata?.promptTokenCount || 0,
          outputTokens: automationGenerated.usageMetadata?.candidatesTokenCount || 0,
          score: automationScore,
          exitCode: execution.exitCode,
          requestCount: execution.audit.length,
          literalRouteMatches: routeMatches,
          responseId: automationGenerated.responseId,
        },
      };
      result.runs.push(run);
      fs.writeFileSync(
        path.join(runRoot, 'contract.json'),
        `${JSON.stringify(contractGenerated.data, null, 2)}\n`,
      );
      fs.writeFileSync(
        path.join(runRoot, 'automation-result.json'),
        `${JSON.stringify({
          assessment: automationGenerated.data.assessment,
          execution,
          score: automationScore,
        }, null, 2)}\n`,
      );
      fs.writeFileSync(path.join(runRoot, 'run.json'), `${JSON.stringify(run, null, 2)}\n`);
      console.log(
        `${definition.id} ${condition.id}: contract ${contractEvaluation.qualityScore}/100, `
        + `automation ${automationScore.accepted ? 'PASS' : 'FAIL'}`,
      );

      if (condition.id === 'none') {
        targetResult.noEvidence = {
          contractEndpointRecall: contractEvaluation.endpointRecall,
          literalRouteMatches: routeMatches,
          automationAccepted: automationScore.accepted,
          contaminated: contractEvaluation.endpointRecall > 0 || routeMatches.length > 0,
        };
      }
    }
    result.targets.push(targetResult);
  }
  addAggregates(result);
  fs.writeFileSync(path.join(outputRoot, 'matrix.json'), `${JSON.stringify(result, null, 2)}\n`);
  fs.writeFileSync(path.join(outputRoot, 'matrix.md'), `${markdownReport(result)}\n`);
  console.log(`Public benchmark: ${path.join(outputRoot, 'matrix.md')}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  AUTOMATION_SCHEMA,
  PUBLIC_CONTRACT_SCHEMA,
  addAggregates,
  addSemanticAutomationScore,
  aggregateRuns,
  evaluateExecutableReadiness,
  literalRouteMatches,
  markdownReport,
  targetDefinitions,
  validateAutomationCode,
};
