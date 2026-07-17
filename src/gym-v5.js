'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { V5_CASES } = require('../gym/v5-cases');

function round(value, digits = 3) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function harmonicMean(precision, recall) {
  return precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
}

function includesRoute(value, route) {
  const text = String(value || '');
  if (text.includes(route)) return true;
  const action = route.split('/').filter(Boolean).at(-1);
  return text.includes(`/${action}?`)
    || text.includes(`/${action} ::`)
    || text.endsWith(`/${action}`);
}

function classificationsOf(endpoint) {
  const value = endpoint.classifications;
  return Array.isArray(value) ? value : [value];
}

function relationText(relation) {
  return JSON.stringify(relation);
}

function transformMatches(relation, expected) {
  const text = relationText(relation);
  return Object.entries(expected).every(([key, value]) => (
    text.includes(`"${key}":${JSON.stringify(value)}`)
  ));
}

function relationMatches(relation, expected, definition) {
  const text = relationText(relation);
  const sourceRoute = definition.routes[expected.sourceRoute];
  const targetRoute = definition.routes[expected.targetRoute];
  return relation.kind === expected.kind
    && includesRoute(text, sourceRoute)
    && includesRoute(text, targetRoute)
    && expected.sourceFields.every((field) => text.includes(field))
    && text.includes(expected.targetField)
    && transformMatches(relation, expected.transform);
}

function predictedEndpoints(output, mode) {
  return mode === 'single' ? output.endpoints : output.crossSessionEndpoints;
}

function predictedWorkflow(output, mode) {
  return (mode === 'single' ? output.workflow : output.consensusWorkflow)
    .map((step) => step.endpoint);
}

function predictedRelations(output, mode) {
  return mode === 'single' ? output.relations : output.crossSessionRelations;
}

function orderedRecall(actual, expected) {
  let matched = 0;
  for (const route of actual) {
    if (includesRoute(route, expected[matched])) matched += 1;
    if (matched === expected.length) break;
  }
  return expected.length ? matched / expected.length : 1;
}

function evaluateFarmerOutput(definition, output, mode) {
  const endpoints = predictedEndpoints(output, mode);
  const workflow = predictedWorkflow(output, mode);
  const relations = predictedRelations(output, mode);
  const truth = definition.groundTruth;

  const correctlyCore = truth.coreRoutes.filter((route) => endpoints.some((endpoint) => (
    includesRoute(endpoint.signature, route) && classificationsOf(endpoint).includes('core')
  ))).length;
  const predictedCore = endpoints.filter((endpoint) => classificationsOf(endpoint).includes('core'));
  const truePredictedCore = predictedCore.filter((endpoint) => truth.coreRoutes.some((route) => (
    includesRoute(endpoint.signature, route)
  ))).length;
  const coreRecall = correctlyCore / Math.max(truth.coreRoutes.length, 1);
  const corePrecision = truePredictedCore / Math.max(predictedCore.length, 1);
  const coreF1 = harmonicMean(corePrecision, coreRecall);

  const correctlyNoise = truth.noiseRoutes.filter((route) => endpoints.some((endpoint) => (
    includesRoute(endpoint.signature, route)
    && classificationsOf(endpoint).some((value) => String(value).endsWith('noise'))
  ))).length;
  const noiseRecall = truth.noiseRoutes.length
    ? correctlyNoise / truth.noiseRoutes.length
    : 1;

  const workflowRecall = orderedRecall(workflow, truth.workflow);
  const endpointById = new Map(endpoints.map((endpoint) => [endpoint.id, endpoint]));
  const coreRelations = relations.filter((relation) => {
    if (mode === 'cross-session') {
      return relation.sourceEndpointClassifications?.includes('core')
        && relation.targetEndpointClassifications?.includes('core');
    }
    return classificationsOf(endpointById.get(relation.source?.endpointId) || {}).includes('core')
      && classificationsOf(endpointById.get(relation.target?.endpointId) || {}).includes('core');
  });
  const matchedRelations = truth.relations.filter((expected) => (
    coreRelations.some((relation) => relationMatches(relation, expected, definition))
  ));
  const targetFields = new Set(truth.relations.map((expected) => expected.targetField));
  const relevantPredictions = coreRelations.filter((relation) => {
    const text = relationText(relation);
    return includesRoute(text, definition.routes.close)
      && [...targetFields].some((field) => text.includes(field));
  });
  const relationRecall = matchedRelations.length / Math.max(truth.relations.length, 1);
  const matchedPredictionCount = relevantPredictions.filter((relation) => (
    truth.relations.some((expected) => relationMatches(relation, expected, definition))
  )).length;
  const relationPrecision = matchedPredictionCount / Math.max(relevantPredictions.length, 1);
  const relationF1 = harmonicMean(relationPrecision, relationRecall);
  const score = (
    coreF1 * 25
    + noiseRecall * 15
    + workflowRecall * 20
    + relationF1 * 40
  );

  return {
    mode,
    score: round(score, 2),
    endpointClassification: {
      corePrecision: round(corePrecision),
      coreRecall: round(coreRecall),
      coreF1: round(coreF1),
      noiseRecall: round(noiseRecall),
    },
    workflow: {
      orderedRecall: round(workflowRecall),
      expected: truth.workflow,
      predicted: workflow,
    },
    relations: {
      precision: round(relationPrecision),
      recall: round(relationRecall),
      f1: round(relationF1),
      expected: truth.relations.length,
      matched: matchedRelations.length,
      relevantPredictions: relevantPredictions.length,
      missed: truth.relations.filter((expected) => !matchedRelations.includes(expected)),
    },
  };
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function aggregateV5(cases) {
  const arms = ['single', 'cross-session'];
  return arms.map((arm) => {
    const armCases = cases.map((item) => item[arm]);
    return {
      arm,
      cases: armCases.length,
      meanScore: round(mean(armCases.map((item) => item.score)), 2),
      meanCoreF1: round(mean(armCases.map((item) => item.endpointClassification.coreF1))),
      meanNoiseRecall: round(mean(armCases.map((item) => item.endpointClassification.noiseRecall))),
      meanWorkflowRecall: round(mean(armCases.map((item) => item.workflow.orderedRecall))),
      meanRelationF1: round(mean(armCases.map((item) => item.relations.f1))),
      relationCasesFullyRecovered: armCases.filter((item) => item.relations.recall === 1).length,
    };
  });
}

function aggregateAxes(cases) {
  const axisIds = [...new Set(cases.map((item) => item.axis))];
  return axisIds.map((axis) => {
    const selected = cases.filter((item) => item.axis === axis);
    return {
      axis,
      cases: selected.length,
      singleMeanScore: round(mean(selected.map((item) => item.single.score)), 2),
      crossSessionMeanScore: round(mean(selected.map((item) => item['cross-session'].score)), 2),
      singleRelationRecall: round(mean(selected.map((item) => item.single.relations.recall))),
      crossSessionRelationRecall: round(mean(selected.map((item) => item['cross-session'].relations.recall))),
    };
  });
}

function markdownReport(result) {
  const lines = [
    '# Farmer Gym A/B V5',
    '',
    `- ${result.cases.length} cases across three validation axes.`,
    '- A: farmer output from the first five-iteration recording session.',
    '- B: farmer output aggregated across three sessions / fifteen iterations.',
    '- No Gemini generation or Gemini acceptance score is used.',
    '- Farmer score: 25 endpoint core F1 + 15 noise recall + 20 ordered workflow recall + 40 relation F1.',
    '',
    '| Case | Axis | A score | B score | A relation recall | B relation recall |',
    '|---|---|---:|---:|---:|---:|',
  ];
  for (const item of result.cases) {
    lines.push(`| ${item.id} | ${item.axis} | ${item.single.score.toFixed(2)} | ${item['cross-session'].score.toFixed(2)} | ${(item.single.relations.recall * 100).toFixed(0)}% | ${(item['cross-session'].relations.recall * 100).toFixed(0)}% |`);
  }
  lines.push('', '## Aggregate A/B', '');
  lines.push('| Arm | Mean score | Core F1 | Noise recall | Workflow recall | Relation F1 | Full relation cases |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|');
  for (const aggregate of result.aggregates) {
    lines.push(`| ${aggregate.arm} | ${aggregate.meanScore.toFixed(2)} | ${(aggregate.meanCoreF1 * 100).toFixed(1)}% | ${(aggregate.meanNoiseRecall * 100).toFixed(1)}% | ${(aggregate.meanWorkflowRecall * 100).toFixed(1)}% | ${(aggregate.meanRelationF1 * 100).toFixed(1)}% | ${aggregate.relationCasesFullyRecovered}/${aggregate.cases} |`);
  }
  lines.push('', '## Three validation axes', '');
  lines.push('| Axis | Cases | A score | B score | A relation recall | B relation recall |');
  lines.push('|---|---:|---:|---:|---:|---:|');
  for (const aggregate of result.axes) {
    lines.push(`| ${aggregate.axis} | ${aggregate.cases} | ${aggregate.singleMeanScore.toFixed(2)} | ${aggregate.crossSessionMeanScore.toFixed(2)} | ${(aggregate.singleRelationRecall * 100).toFixed(1)}% | ${(aggregate.crossSessionRelationRecall * 100).toFixed(1)}% |`);
  }
  lines.push('', '## Guardrails', '');
  lines.push('- Ground truth is defined by the Gym independently of the farmer output.');
  lines.push('- The score measures extraction fidelity, not whether a downstream model can write working automation.');
  lines.push('- Hash relations are tested candidates supported by repeated observations, not proof of source-code causality.');
  return `${lines.join('\n')}\n`;
}

function buildV5Result(caseOutputs) {
  const cases = V5_CASES.map((definition) => {
    const outputs = caseOutputs.get(definition.id);
    if (!outputs) throw new Error(`Missing V5 farmer output: ${definition.id}`);
    return {
      id: definition.id,
      title: definition.title,
      axis: definition.axis.id,
      single: evaluateFarmerOutput(definition, outputs.single, 'single'),
      'cross-session': evaluateFarmerOutput(definition, outputs.crossSession, 'cross-session'),
    };
  });
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    benchmark: 'farmer-gym-v5',
    arms: {
      A: 'single',
      B: 'cross-session',
    },
    cases,
    aggregates: aggregateV5(cases),
    axes: aggregateAxes(cases),
  };
}

function writeV5Result(outputRoot, result) {
  fs.mkdirSync(outputRoot, { recursive: true });
  fs.writeFileSync(path.join(outputRoot, 'matrix.json'), `${JSON.stringify(result, null, 2)}\n`);
  fs.writeFileSync(path.join(outputRoot, 'matrix.md'), markdownReport(result));
}

module.exports = {
  buildV5Result,
  evaluateFarmerOutput,
  markdownReport,
  relationMatches,
  writeV5Result,
};
