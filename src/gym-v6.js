'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { evaluateFarmerOutput } = require('./gym-v5');

function round(value, digits = 3) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function semanticMembers(output, mode) {
  const endpoints = mode === 'single' ? output.endpoints : output.crossSessionEndpoints;
  return endpoints.flatMap((endpoint) => endpoint.members || []);
}

function normalizedPath(value) {
  return String(value).replace(/\/\d+(?=\/|$)/g, '/:number');
}

function evaluateSemanticSiblings(definition, output, mode, expectedSupport) {
  const members = semanticMembers(output, mode);
  let covered = 0;
  let exactStatuses = 0;
  let exactSchemas = 0;
  let supported = 0;
  for (const expected of definition.groundTruth.members) {
    const member = members.find((candidate) => (
      normalizedPath(candidate.pathnameTemplate) === normalizedPath(expected.path)
      || normalizedPath(candidate.routeKey).endsWith(normalizedPath(expected.path))
      || normalizedPath(candidate.signature).includes(normalizedPath(expected.path))
    ));
    if (!member) continue;
    covered += 1;
    const statuses = Object.keys(member.statusCounts || {}).map(Number).sort((a, b) => a - b);
    if (JSON.stringify(statuses) === JSON.stringify([expected.status])) exactStatuses += 1;
    const responseSchemas = member.responseSchemas || [];
    const hasExpected = responseSchemas.some((schema) => schema.fieldPath === expected.responseField);
    const hasSiblingField = definition.groundTruth.members
      .filter((sibling) => sibling !== expected)
      .some((sibling) => responseSchemas.some((schema) => schema.fieldPath === sibling.responseField));
    if (hasExpected && !hasSiblingField) exactSchemas += 1;
    const presence = mode === 'single' ? member.iterationPresence : member.sessionPresence;
    if (presence === expectedSupport) supported += 1;
  }
  const count = definition.groundTruth.members.length;
  const memberCoverage = covered / count;
  const statusAccuracy = exactStatuses / count;
  const schemaAccuracy = exactSchemas / count;
  const supportAccuracy = supported / count;
  return {
    mode,
    score: round(
      memberCoverage * 30
      + statusAccuracy * 30
      + schemaAccuracy * 30
      + supportAccuracy * 10,
      2,
    ),
    memberAttribution: {
      expected: count,
      predicted: members.length,
      coverage: round(memberCoverage),
      exactStatusAccuracy: round(statusAccuracy),
      exactSchemaAccuracy: round(schemaAccuracy),
      exactSupportAccuracy: round(supportAccuracy),
    },
  };
}

function evaluateV6Case(definition, outputs, configuration) {
  if (definition.family === 'semantic-siblings') {
    return {
      id: definition.id,
      seed: definition.seed,
      family: definition.family,
      single: evaluateSemanticSiblings(
        definition,
        outputs.single,
        'single',
        configuration.iterationsPerSession,
      ),
      'cross-session': evaluateSemanticSiblings(
        definition,
        outputs.crossSession,
        'cross-session',
        configuration.sessionsPerCase,
      ),
    };
  }
  return {
    id: definition.id,
    seed: definition.seed,
    family: definition.family,
    single: evaluateFarmerOutput(definition, outputs.single, 'single'),
    'cross-session': evaluateFarmerOutput(definition, outputs.crossSession, 'cross-session'),
  };
}

function buildV6Result(suites, caseOutputs, configuration) {
  const cases = suites.flatMap((suite) => suite.cases.map((definition) => (
    evaluateV6Case(definition, caseOutputs.get(definition.id), configuration)
  )));
  const families = [...new Set(cases.map((item) => item.family))];
  const aggregates = ['single', 'cross-session'].map((arm) => ({
    arm,
    meanScore: round(mean(cases.map((item) => item[arm].score)), 2),
    worstCaseScore: Math.min(...cases.map((item) => item[arm].score)),
    relationRecall: round(mean(cases
      .filter((item) => item[arm].relations)
      .map((item) => item[arm].relations.recall))),
    perfectCaseRate: round(cases.filter((item) => item[arm].score === 100).length / cases.length),
  }));
  const familyAggregates = families.map((family) => {
    const selected = cases.filter((item) => item.family === family);
    return {
      family,
      cases: selected.length,
      singleMeanScore: round(mean(selected.map((item) => item.single.score)), 2),
      crossSessionMeanScore: round(mean(selected.map((item) => item['cross-session'].score)), 2),
      crossSessionRelationRecall: selected.some((item) => item['cross-session'].relations)
        ? round(mean(selected
          .filter((item) => item['cross-session'].relations)
          .map((item) => item['cross-session'].relations.recall)))
        : null,
    };
  });
  return {
    schemaVersion: 1,
    benchmark: configuration.benchmark || 'farmer-gym-v6',
    generatedAt: new Date().toISOString(),
    seeds: suites.map((suite) => suite.seed),
    configuration,
    cases,
    aggregates,
    familyAggregates,
  };
}

function markdownReport(result) {
  const lines = [
    `# ${result.benchmark} - seeded novel holdouts`,
    '',
    `Seeds: ${result.seeds.join(', ')}.`,
    `${result.cases.length} generated cases; ${result.configuration.sessionsPerCase} sessions x ${result.configuration.iterationsPerSession} iterations per case.`,
    '',
    '## Aggregate',
    '',
    '| Arm | Mean score | Worst case | Relation recall | Perfect case rate |',
    '|---|---:|---:|---:|---:|',
  ];
  for (const aggregate of result.aggregates) {
    lines.push(`| ${aggregate.arm} | ${aggregate.meanScore} | ${aggregate.worstCaseScore} | ${(aggregate.relationRecall * 100).toFixed(1)}% | ${(aggregate.perfectCaseRate * 100).toFixed(1)}% |`);
  }
  lines.push(
    '',
    '## Novel family results',
    '',
    '| Family | Cases | Single | Cross-session | Cross relation recall |',
    '|---|---:|---:|---:|---:|',
  );
  for (const family of result.familyAggregates) {
    const relationRecall = family.crossSessionRelationRecall === null
      ? 'n/a'
      : `${(family.crossSessionRelationRecall * 100).toFixed(1)}%`;
    lines.push(`| ${family.family} | ${family.cases} | ${family.singleMeanScore} | ${family.crossSessionMeanScore} | ${relationRecall} |`);
  }
  lines.push(
    '',
    '## Interpretation',
    '',
    '- Route names, field names, prefixes, numeric coefficients, noise counts, and decoy sizes are generated from each suite seed.',
    '- Novel transforms are intentionally scored even when the current farmer has no detector; low scores expose capability gaps rather than benchmark failures.',
    '- Hash/HMAC candidates remain evidence-bounded hypotheses and never prove source-code causality.',
  );
  return `${lines.join('\n')}\n`;
}

function writeV6Result(outputRoot, result) {
  fs.mkdirSync(outputRoot, { recursive: true });
  fs.writeFileSync(path.join(outputRoot, 'matrix.json'), `${JSON.stringify(result, null, 2)}\n`);
  fs.writeFileSync(path.join(outputRoot, 'matrix.md'), markdownReport(result));
}

module.exports = {
  buildV6Result,
  evaluateSemanticSiblings,
  evaluateV6Case,
  markdownReport,
  writeV6Result,
};
