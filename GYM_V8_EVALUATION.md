# Farmer Gym V8 - randomized lineage compression

## Objective

V8 tests whether lineage compression preserves ordinary website data flows.
It does not use custom hashes or unusual transform puzzles. Routes, field
names, values, noise counts, and concrete action names are generated from a
seed.

There are five configurations with exactly five cases each:

| Configuration | Cases | Website-like behavior under test |
|---|---:|---|
| CRUD dense propagation | 5 | One resource ID flows through create, detail, update, audit, and delete |
| Session fan-out | 5 | One session ID is reused by profile, preferences, orders, and logout |
| Parallel identities | 5 | Account and order IDs travel together but must remain separate lineages |
| Semantic siblings | 5 | Finite action siblings share a workspace ID without losing concrete provenance |
| Optional session | 5 | A stable relation is actionable while a one-session relation remains candidate-only |

Every case contains two sessions, four iterations per session, and randomized
telemetry noise.

## Score

The score is independent from the lineage implementation:

- 25 points: expected point coverage;
- 30 points: direct observed edge recall;
- 20 points: lineage purity, including no merge across parallel identities;
- 15 points: connected and minimal backbone view;
- 10 points: correct actionable-versus-candidate tier.

Direct-edge ground truth is derived from the declared request/response
timeline. For example, five ordered CRUD occurrences imply ten direct observed
edges even though a navigation backbone needs only four.

## Results

The canonical seed `88001` produced 25/25 perfect cases:

| Configuration | Mean | Worst | Candidate backbone/direct ratio |
|---|---:|---:|---:|
| CRUD dense propagation | 100 | 100 | 40.0% |
| Session fan-out | 100 | 100 | 40.0% |
| Parallel identities | 100 | 100 | 50.0% |
| Semantic siblings | 100 | 100 | 50.0% |
| Optional session | 100 | 100 | 66.7% |

A separate holdout seed, `88019`, also produced 25/25 perfect cases.

This means the compressed backbone did not remove direct-edge evidence, merge
the two independent identity lineages, lose semantic sibling points, or
promote the optional one-session relation.

## What 100/100 does not mean

- V8 validates the five generated website patterns, not every production
  topology.
- The benchmark primarily stresses exact-copy lineage compression. Complex
  transforms remain covered by V6/V7.
- Timing races, redirects, streaming, malformed bodies, and multi-tab
  concurrency are not represented.
- The backbone is an undirected navigation view over exact-copy components; it
  is not proof of causal direction. Direct directed edges remain canonical.

## Reproduce

```powershell
npm run gym:v8

$env:GYM_V8_SEED = '88019'
$env:GYM_V8_OUTPUT = 'generated/gym-ab-v8-holdout'
npm run gym:v8
```
