'use strict';

const fs = require('node:fs');
const path = require('node:path');

function round(value, digits = 3) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function normalizeRoute(value) {
  return String(value)
    .replace(/\/\d+(?=\/|$)/g, '/:number')
    .replace(/\?.*$/, '');
}

function expectedPoints(definition, lineage) {
  const points = [];
  for (let stepIndex = 0; stepIndex < definition.steps.length; stepIndex += 1) {
    const item = definition.steps[stepIndex];
    for (const requestLink of item.requestLinks.filter((link) => link.lineage === lineage.id)) {
      points.push({
        key: `${item.role}|request|${requestLink.location}|${requestLink.field}`,
        role: item.role,
        method: item.method,
        route: item.route,
        stepIndex,
        side: 'request',
        location: requestLink.location === 'query' ? 'url.query' : 'body.json',
        fieldPath: requestLink.location === 'query'
          ? `$query.${requestLink.field}`
          : `$.${requestLink.field}`,
      });
    }
    for (const responseLink of item.responseLinks.filter((link) => link.lineage === lineage.id)) {
      points.push({
        key: `${item.role}|response|body|${responseLink.field}`,
        role: item.role,
        method: item.method,
        route: item.route,
        stepIndex,
        side: 'response',
        location: 'body.json',
        fieldPath: `$.${responseLink.field}`,
      });
    }
  }
  return points;
}

function directionAllowed(source, target) {
  if (source.stepIndex > target.stepIndex) return false;
  if (source.stepIndex === target.stepIndex) {
    return source.side === 'request' && target.side === 'response';
  }
  if (source.side === 'response') return true;
  return source.side === 'request' && target.side === 'request';
}

function expectedEdges(points) {
  const edges = [];
  for (let sourceIndex = 0; sourceIndex < points.length; sourceIndex += 1) {
    for (let targetIndex = sourceIndex + 1; targetIndex < points.length; targetIndex += 1) {
      if (directionAllowed(points[sourceIndex], points[targetIndex])) {
        edges.push([points[sourceIndex].key, points[targetIndex].key]);
      }
    }
  }
  return edges;
}

function pointMatches(actual, expected) {
  const route = normalizeRoute(actual.routeKey);
  return route.startsWith(`${expected.method} `)
    && route.includes(normalizeRoute(expected.route))
    && actual.side === expected.side
    && actual.location === expected.location
    && actual.fieldPath === expected.fieldPath;
}

function mapExpectedPoints(index, points) {
  const actualEntries = Object.entries(index.points || {});
  return new Map(points.map((expected) => {
    const match = actualEntries.find(([, actual]) => pointMatches(actual, expected));
    return [expected.key, match?.[0] || null];
  }));
}

function connectedByBackbone(index, group, pointIds) {
  if (pointIds.length <= 1) return true;
  const edgeById = new Map(index.directExactEdges.map((edge) => [edge.id, edge]));
  const adjacency = new Map(pointIds.map((id) => [id, new Set()]));
  for (const edgeId of group.backboneEdgeIds) {
    const edge = edgeById.get(edgeId);
    if (!edge) continue;
    const source = edge.sourcePointIds[0];
    const target = edge.targetPointId;
    if (!adjacency.has(source) || !adjacency.has(target)) continue;
    adjacency.get(source).add(target);
    adjacency.get(target).add(source);
  }
  const visited = new Set([pointIds[0]]);
  const pending = [pointIds[0]];
  while (pending.length) {
    const current = pending.pop();
    for (const next of adjacency.get(current) || []) {
      if (visited.has(next)) continue;
      visited.add(next);
      pending.push(next);
    }
  }
  return pointIds.every((id) => visited.has(id));
}

function evaluateLineage(definition, lineage, actionableIndex, candidateIndex) {
  const expected = expectedPoints(definition, lineage);
  const targetIndex = lineage.scope === 'candidate-only' ? candidateIndex : actionableIndex;
  const mapped = mapExpectedPoints(targetIndex, expected);
  const mappedPointIds = [...mapped.values()].filter(Boolean);
  const pointCoverage = mappedPointIds.length / Math.max(expected.length, 1);
  const group = targetIndex.lineageGroups.find((candidate) => (
    mappedPointIds.length
    && mappedPointIds.every((id) => candidate.memberPointIds.includes(id))
  ));
  const otherExpectedIds = definition.lineages
    .filter((other) => other.id !== lineage.id)
    .flatMap((other) => [...mapExpectedPoints(targetIndex, expectedPoints(definition, other)).values()])
    .filter(Boolean);
  const groupPurity = group && !otherExpectedIds.some((id) => group.memberPointIds.includes(id)) ? 1 : 0;
  const actualEdges = new Set(targetIndex.directExactEdges.map((edge) => (
    `${edge.sourcePointIds[0]}|${edge.targetPointId}`
  )));
  const expectedDirectEdges = expectedEdges(expected);
  const matchedEdges = expectedDirectEdges.filter(([sourceKey, targetKey]) => {
    const sourceId = mapped.get(sourceKey);
    const targetId = mapped.get(targetKey);
    return sourceId && targetId && actualEdges.has(`${sourceId}|${targetId}`);
  }).length;
  const directEdgeRecall = matchedEdges / Math.max(expectedDirectEdges.length, 1);
  const backboneConnected = group
    ? connectedByBackbone(targetIndex, group, mappedPointIds)
    : false;
  const minimalBackbone = group
    ? group.backboneEdgeIds.length <= Math.max(group.memberPointIds.length - 1, 0)
    : false;
  const actionablePointMap = mapExpectedPoints(actionableIndex, expected);
  const actionablePresence = [...actionablePointMap.values()].filter(Boolean).length > 1;
  const tierAccuracy = lineage.scope === 'candidate-only'
    ? (!actionablePresence && pointCoverage === 1 ? 1 : 0)
    : (actionablePresence && pointCoverage === 1 ? 1 : 0);
  const score = round(
    pointCoverage * 25
    + directEdgeRecall * 30
    + groupPurity * 20
    + (backboneConnected ? 10 : 0)
    + (minimalBackbone ? 5 : 0)
    + tierAccuracy * 10,
    2,
  );
  return {
    id: lineage.id,
    scope: lineage.scope,
    score,
    pointCoverage: round(pointCoverage),
    directEdgeRecall: round(directEdgeRecall),
    groupPurity,
    backboneConnected,
    minimalBackbone,
    tierAccuracy,
    expectedPoints: expected.length,
    expectedDirectEdges: expectedDirectEdges.length,
    matchedDirectEdges: matchedEdges,
    group: group ? {
      memberCount: group.memberPointIds.length,
      directEdgeCount: group.directEdgeIds.length,
      backboneEdgeCount: group.backboneEdgeIds.length,
      redundantEdgeCount: group.redundantEdgeIds.length,
    } : null,
  };
}

function evaluateV8Case(definition, farmed) {
  const lineages = definition.lineages.map((lineage) => evaluateLineage(
    definition,
    lineage,
    farmed.summary.crossSessionLineage,
    farmed.summary.crossSessionCandidateLineage,
  ));
  return {
    id: definition.id,
    configuration: definition.configuration,
    score: round(lineages.reduce((sum, item) => sum + item.score, 0) / lineages.length, 2),
    lineages,
    compression: {
      actionable: farmed.summary.crossSessionLineage.stats,
      candidates: farmed.summary.crossSessionCandidateLineage.stats,
    },
  };
}

function buildV8Result(suite, caseResults, configuration) {
  const configurations = suite.configurations.map((name) => {
    const selected = caseResults.filter((item) => item.configuration === name);
    return {
      configuration: name,
      cases: selected.length,
      meanScore: round(selected.reduce((sum, item) => sum + item.score, 0) / selected.length, 2),
      worstScore: Math.min(...selected.map((item) => item.score)),
      meanCandidateBackboneRatio: round(
        selected.reduce(
          (sum, item) => sum + item.compression.candidates.backboneCompressionRatio,
          0,
        ) / selected.length,
      ),
    };
  });
  return {
    schemaVersion: 1,
    benchmark: suite.benchmark,
    generatedAt: new Date().toISOString(),
    seed: suite.seed,
    configuration,
    cases: caseResults,
    aggregates: {
      cases: caseResults.length,
      meanScore: round(caseResults.reduce((sum, item) => sum + item.score, 0) / caseResults.length, 2),
      worstScore: Math.min(...caseResults.map((item) => item.score)),
      perfectCaseRate: round(caseResults.filter((item) => item.score === 100).length / caseResults.length),
    },
    configurations,
  };
}

function markdownReport(result) {
  const lines = [
    '# Farmer Gym V8 - lineage compression',
    '',
    `Seed: ${result.seed}. ${result.aggregates.cases} cases; ${result.configuration.sessionsPerCase} sessions x ${result.configuration.iterationsPerSession} iterations.`,
    '',
    `Mean score: **${result.aggregates.meanScore}/100**. Worst: **${result.aggregates.worstScore}**. Perfect cases: **${(result.aggregates.perfectCaseRate * 100).toFixed(1)}%**.`,
    '',
    '| Configuration | Cases | Mean | Worst | Candidate backbone/direct ratio |',
    '|---|---:|---:|---:|---:|',
  ];
  for (const item of result.configurations) {
    lines.push(`| ${item.configuration} | ${item.cases} | ${item.meanScore} | ${item.worstScore} | ${(item.meanCandidateBackboneRatio * 100).toFixed(1)}% |`);
  }
  lines.push(
    '',
    'The score requires point coverage, direct-edge preservation, lineage purity, connected/minimal backbone, and correct actionable-versus-candidate tiering.',
  );
  return `${lines.join('\n')}\n`;
}

function writeV8Result(outputRoot, result) {
  fs.mkdirSync(outputRoot, { recursive: true });
  fs.writeFileSync(path.join(outputRoot, 'matrix.json'), `${JSON.stringify(result, null, 2)}\n`);
  fs.writeFileSync(path.join(outputRoot, 'matrix.md'), markdownReport(result));
}

module.exports = {
  buildV8Result,
  evaluateV8Case,
  expectedEdges,
  expectedPoints,
  markdownReport,
  writeV8Result,
};
