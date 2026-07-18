'use strict';

const crypto = require('node:crypto');

function shortHash(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function normalizePoint(point) {
  return {
    routeKey: point.routeKey || point.endpoint,
    side: point.side,
    location: point.location,
    fieldPath: point.fieldPath,
  };
}

function pointKey(point) {
  const normalized = normalizePoint(point);
  return [
    normalized.routeKey,
    normalized.side,
    normalized.location,
    normalized.fieldPath,
  ].join('|');
}

function pointId(point) {
  return shortHash(pointKey(point));
}

class DisjointSet {
  constructor() {
    this.parents = new Map();
  }

  add(value) {
    if (!this.parents.has(value)) this.parents.set(value, value);
  }

  find(value) {
    this.add(value);
    const parent = this.parents.get(value);
    if (parent === value) return value;
    const root = this.find(parent);
    this.parents.set(value, root);
    return root;
  }

  union(left, right) {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot === rightRoot) return false;
    this.parents.set(rightRoot, leftRoot);
    return true;
  }
}

function compactSupport(relation) {
  return {
    sessions: relation.sessionPresence || 1,
    iterations: relation.supportIterations || 0,
    distinctSourceValues: relation.distinctSourceValues || 0,
    confidence: relation.averageConfidence ?? relation.confidence ?? null,
    medianRequestDistance: relation.medianRequestDistance ?? null,
  };
}

function buildLineageIndex(relations, {
  benchmark = 'relation-lineage',
  scope = 'actionable',
} = {}) {
  const points = new Map();
  const exactEdges = [];
  const transformEdges = [];
  const connectivity = new DisjointSet();
  const rememberPoint = (point) => {
    const normalized = normalizePoint(point);
    const id = pointId(normalized);
    if (!points.has(id)) points.set(id, normalized);
    return id;
  };

  for (const relation of relations) {
    const sources = relation.sources?.length ? relation.sources : [relation.source];
    const sourceIds = sources.map(rememberPoint);
    const targetId = rememberPoint(relation.target);
    const edge = {
      id: relation.id || shortHash([
        relation.kind,
        ...sourceIds,
        targetId,
        JSON.stringify(relation.transform || relation.transforms || []),
      ].join('|')),
      kind: relation.kind,
      sourcePointIds: sourceIds,
      targetPointId: targetId,
      support: compactSupport(relation),
      sessionSupport: relation.sessionSupport || [],
      transforms: relation.transforms || (relation.transform ? [relation.transform] : []),
      evidenceTier: relation.evidenceTier || relation.evidenceTiers || ['supported'],
      promotion: relation.promotion,
    };
    if (relation.kind === 'exact-copy' && sourceIds.length === 1) {
      exactEdges.push(edge);
      connectivity.union(sourceIds[0], targetId);
    } else {
      transformEdges.push(edge);
    }
  }

  const components = new Map();
  for (const edge of exactEdges) {
    const root = connectivity.find(edge.sourcePointIds[0]);
    if (!components.has(root)) components.set(root, { members: new Set(), edges: [] });
    const component = components.get(root);
    component.members.add(edge.sourcePointIds[0]);
    component.members.add(edge.targetPointId);
    component.edges.push(edge);
  }
  const lineageGroups = [...components.values()].map((component) => {
    const spanning = new DisjointSet();
    const ranked = [...component.edges].sort((left, right) => (
      right.support.sessions - left.support.sessions
      || right.support.iterations - left.support.iterations
      || (right.support.confidence || 0) - (left.support.confidence || 0)
      || left.id.localeCompare(right.id)
    ));
    const backboneEdgeIds = [];
    const redundantEdgeIds = [];
    for (const edge of ranked) {
      if (spanning.union(edge.sourcePointIds[0], edge.targetPointId)) {
        backboneEdgeIds.push(edge.id);
      } else {
        redundantEdgeIds.push(edge.id);
      }
    }
    const memberPointIds = [...component.members].sort();
    return {
      id: shortHash(memberPointIds.join('|')),
      memberPointIds,
      directEdgeIds: component.edges.map((edge) => edge.id).sort(),
      backboneEdgeIds: backboneEdgeIds.sort(),
      redundantEdgeIds: redundantEdgeIds.sort(),
    };
  }).sort((left, right) => (
    right.directEdgeIds.length - left.directEdgeIds.length || left.id.localeCompare(right.id)
  ));

  const backboneEdgeCount = lineageGroups
    .reduce((sum, group) => sum + group.backboneEdgeIds.length, 0);
  return {
    schemaVersion: 1,
    benchmark,
    scope,
    note: 'Backbone and redundant edges are views. Direct edge evidence remains available by ID.',
    stats: {
      relationCount: relations.length,
      pointCount: points.size,
      exactDirectEdgeCount: exactEdges.length,
      transformEdgeCount: transformEdges.length,
      lineageGroupCount: lineageGroups.length,
      backboneEdgeCount,
      redundantExactEdgeCount: exactEdges.length - backboneEdgeCount,
      backboneCompressionRatio: exactEdges.length
        ? Math.round((backboneEdgeCount / exactEdges.length) * 10_000) / 10_000
        : 1,
    },
    points: Object.fromEntries([...points.entries()].sort(([left], [right]) => left.localeCompare(right))),
    lineageGroups,
    directExactEdges: exactEdges,
    transformEdges,
  };
}

module.exports = {
  buildLineageIndex,
  normalizePoint,
  pointId,
  pointKey,
};
