'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { generateJsonWithFallback } = require('./gemini');
const { selectContext, validateGeneratedCode } = require('./automation-demo');

const AB_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['assessment', 'automations'],
  properties: {
    assessment: {
      type: 'object',
      additionalProperties: false,
      required: ['priorKnowledgeUsed', 'confidence', 'assumptions', 'featureFactsUsed', 'missingEvidence'],
      properties: {
        priorKnowledgeUsed: { type: 'boolean' },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        assumptions: { type: 'array', items: { type: 'string' } },
        featureFactsUsed: { type: 'array', items: { type: 'string' } },
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
        required: ['name', 'goal', 'assumptions', 'evidenceUsed', 'code'],
        properties: {
          name: { type: 'string', pattern: '^[a-z][a-z0-9-]{2,50}$' },
          goal: { type: 'string' },
          assumptions: { type: 'array', items: { type: 'string' } },
          evidenceUsed: { type: 'array', items: { type: 'string' } },
          code: { type: 'string' },
        },
      },
    },
  },
};

function buildAbPrompt(evidence) {
  return [
    'You are in a controlled A/B evaluation of prior model knowledge versus machine-farmed HTTP evidence.',
    'Do not browse, use tools, retrieve documentation, or claim you inspected anything outside this prompt.',
    'Target host: https://api.artic.edu. You must infer exact endpoints, methods, request shapes and response shapes.',
    '',
    'Produce exactly three independent CommonJS node:test files for Node.js 20+:',
    '1. Query the collection with the human keyword "netsuke" and validate a non-empty structured result list.',
    '2. Retrieve one concrete record by identifier and validate at least three meaningful response fields.',
    '3. Perform a two-step workflow: query first, extract an identifier from its response, pass that identifier into a second request, and assert consistency.',
    '',
    'Hard constraints for every file:',
    '- Use only built-in fetch, node:test and node:assert/strict.',
    '- Target only api.artic.edu over HTTPS.',
    '- At most three HTTP requests per file; read-only behavior only.',
    '- Use AIC-User-Agent: "features-farming-gemini-ab (local evaluation)".',
    '- Assert HTTP status before parsing JSON.',
    '- Make assertions about observed response structure, not merely that a request completed.',
    '- No environment variables, filesystem, child processes, eval, dynamic imports, proxies, retries or fallback endpoints.',
    '- Each code value must be a complete executable test file.',
    '- Record every assumption explicitly. Do not present assumptions as evidence.',
    '',
    'Evidence policy:',
    '- If EVIDENCE is null, rely only on pre-existing model knowledge and mark priorKnowledgeUsed=true.',
    '- If EVIDENCE is present, use it as the sole source of API-specific facts and mark priorKnowledgeUsed=false.',
    '- featureFactsUsed must quote precise facts from EVIDENCE; it must be empty when EVIDENCE is null.',
    '',
    'EVIDENCE:',
    JSON.stringify(evidence, null, 2),
  ].join('\n');
}

function scoreGeneratedAutomations(automations) {
  const code = automations.map((automation) => automation.code).join('\n');
  const checks = [
    ['search endpoint', /\/api\/v1\/artworks\/search/i],
    ['detail endpoint', /\/api\/v1\/artworks\/(?:\$\{|\d)/i],
    ['POST search method', /method\s*:\s*['"]POST['"]/i],
    ['query payload', /\bq\s*:\s*['"]netsuke['"]/i],
    ['public-domain filter', /is_public_domain/i],
    ['field selection', /\bfields\b/i],
    ['pagination/size control', /\b(?:from|size|limit|page)\s*:/i],
    ['response ID extraction', /\.data\s*\[\s*0\s*\]\s*\.id/i],
    ['ID passed into detail URL', /artworks\/\$\{[^}]*id[^}]*\}/i],
    ['cross-request ID assertion', /(?:strictEqual|equal)\s*\([^,]*\.id\s*,\s*(?:id|artworkId|firstId)/i],
    ['status assertions', /(?:strictEqual|equal)\s*\([^,]*status\s*,\s*200/i],
    ['structured array assertion', /Array\.isArray\s*\(/i],
  ];
  const results = checks.map(([name, pattern]) => ({ name, passed: pattern.test(code) }));
  return {
    score: results.filter((result) => result.passed).length,
    maximum: results.length,
    checks: results,
  };
}

function writeCondition(outputDirectory, condition, generated) {
  const conditionDirectory = path.join(outputDirectory, condition);
  fs.mkdirSync(conditionDirectory, { recursive: true });
  const acceptedFiles = [];
  const rejected = [];
  for (const automation of generated.data.automations) {
    try {
      validateGeneratedCode(automation.code);
      const file = path.join(conditionDirectory, `${automation.name}.test.js`);
      fs.writeFileSync(file, `${automation.code.trim()}\n`);
      acceptedFiles.push(file);
    } catch (error) {
      const file = path.join(conditionDirectory, `${automation.name}.rejected.txt`);
      fs.writeFileSync(file, `${automation.code.trim()}\n`);
      rejected.push({ name: automation.name, reason: error.message, file });
    }
  }
  fs.writeFileSync(path.join(conditionDirectory, 'generation.json'), `${JSON.stringify({
    condition,
    model: generated.model,
    keyIndex: generated.keyIndex,
    usageMetadata: generated.usageMetadata,
    assessment: generated.data.assessment,
    automations: generated.data.automations.map(({ code, ...automation }) => automation),
    rejected: rejected.map(({ file, ...item }) => item),
  }, null, 2)}\n`);
  return { conditionDirectory, acceptedFiles, rejected };
}

function runCondition(files, cwd) {
  if (!files.length) return { passed: false, exitCode: null, passCount: 0, failCount: 0, output: 'No accepted files' };
  const result = spawnSync(process.execPath, ['--test', ...files], {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
    },
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  const passCount = Number(output.match(/ℹ pass (\d+)/)?.[1] || 0);
  const failCount = Number(output.match(/ℹ fail (\d+)/)?.[1] || 0);
  return {
    passed: result.status === 0,
    exitCode: result.status,
    signal: result.signal,
    passCount,
    failCount,
    output: output.slice(0, 20_000),
  };
}

function comparisonMarkdown(comparison) {
  const a = comparison.conditions.noFeatures;
  const b = comparison.conditions.withFeatures;
  const lines = ['# Gemini features A/B comparison', ''];
  lines.push('| Metric | A: no features | B: with features |', '|---|---:|---:|');
  lines.push(`| Accepted generated files | ${a.acceptedCount}/3 | ${b.acceptedCount}/3 |`);
  lines.push(`| Live tests passed | ${a.execution.passCount}/3 | ${b.execution.passCount}/3 |`);
  lines.push(`| Evidence-utilization rubric | ${a.rubric.score}/${a.rubric.maximum} | ${b.rubric.score}/${b.rubric.maximum} |`);
  lines.push(`| Model confidence | ${a.assessment.confidence} | ${b.assessment.confidence} |`);
  lines.push(`| Prompt tokens | ${a.usageMetadata?.promptTokenCount || 'unknown'} | ${b.usageMetadata?.promptTokenCount || 'unknown'} |`);
  lines.push('');
  lines.push('## Rubric differences', '');
  for (const check of a.rubric.checks) {
    const other = b.rubric.checks.find((item) => item.name === check.name);
    if (check.passed !== other?.passed) {
      lines.push(`- ${check.name}: A=${check.passed ? 'yes' : 'no'}, B=${other?.passed ? 'yes' : 'no'}`);
    }
  }
  lines.push('');
  lines.push('## A assumptions', '');
  for (const assumption of a.assessment.assumptions) lines.push(`- ${assumption}`);
  lines.push('');
  lines.push('## B feature facts used', '');
  for (const fact of b.assessment.featureFactsUsed) lines.push(`- ${fact}`);
  lines.push('');
  lines.push('## Interpretation guardrail', '');
  lines.push('Passing A demonstrates prior model knowledge or a successful guess. The incremental value of features is measured by B-only rubric checks, stronger assertions, fewer assumptions, and live reliability--not by B passing alone.');
  return `${lines.join('\n')}\n`;
}

async function runAbDemo({ apiKeys, farmDirectory, outputDirectory }) {
  const crossSession = JSON.parse(fs.readFileSync(path.join(farmDirectory, 'cross-session.json'), 'utf8'));
  const evidence = selectContext(crossSession);
  const conditions = [
    { id: 'no-features', evidence: null },
    { id: 'with-features', evidence },
  ];
  const results = {};
  for (const condition of conditions) {
    const generated = await generateJsonWithFallback({
      apiKeys,
      prompt: buildAbPrompt(condition.evidence),
      responseJsonSchema: AB_RESPONSE_SCHEMA,
      seed: 91_733,
    });
    const written = writeCondition(outputDirectory, condition.id, generated);
    const execution = runCondition(written.acceptedFiles, written.conditionDirectory);
    results[condition.id === 'no-features' ? 'noFeatures' : 'withFeatures'] = {
      model: generated.model,
      keyIndex: generated.keyIndex,
      usageMetadata: generated.usageMetadata,
      assessment: generated.data.assessment,
      acceptedCount: written.acceptedFiles.length,
      rejected: written.rejected.map(({ file, ...item }) => item),
      rubric: scoreGeneratedAutomations(generated.data.automations),
      execution,
      automations: generated.data.automations.map(({ code, ...automation }) => automation),
    };
  }
  const comparison = {
    generatedAt: new Date().toISOString(),
    controls: {
      model: results.noFeatures.model,
      seed: 91_733,
      temperature: 0.15,
      tasks: 3,
      onlyDifference: 'EVIDENCE block: null versus selected farmed features',
    },
    conditions: results,
  };
  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.writeFileSync(path.join(outputDirectory, 'comparison.json'), `${JSON.stringify(comparison, null, 2)}\n`);
  fs.writeFileSync(path.join(outputDirectory, 'comparison.md'), comparisonMarkdown(comparison));
  return comparison;
}

module.exports = {
  AB_RESPONSE_SCHEMA,
  buildAbPrompt,
  runAbDemo,
  scoreGeneratedAutomations,
};
