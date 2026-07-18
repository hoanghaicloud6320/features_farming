# Contract-generation rerun: Gym V1-V8 and KeyManager

## Objective

This rerun measures API-contract generation, not automation generation.
Gemini may return one optional Node.js `fetch` example for the whole suite, but
code is not scored.

All suites use the same four evidence arms:

1. no evidence;
2. compact raw HTTP observations;
3. farmed contract features;
4. raw observations plus farmed features.

The model is `gemini-3.1-flash-lite`. Each suite uses one fixed seed. V1, V2,
and V3 share the original easy, medium, and hard recordings but use different
seeds; they measure generation variance over the same historical evidence
rather than pretending to be separate datasets.

## Contract rubric

The 100-point contract-quality score is:

- 40 points: endpoint precision/recall F1;
- 20 points: exact observed status sets;
- 15 points: request-field recall;
- 15 points: response-field recall;
- 10 points: no hallucinated endpoints.

A complete case requires full endpoint coverage, exact status sets, and no
hallucinated endpoint. Token efficiency is reported both as quality points per
1,000 prompt tokens and as complete cases per 1,000 prompt tokens. The latter
prevents a short but incomplete contract from appearing efficient.

## Overall result

The matrix contains 36 new model calls over 109 case instances.

| Arm | Mean quality | Mean endpoint F1 | Mean exact statuses | Prompt tokens/case | Complete cases/1k tokens |
|---|---:|---:|---:|---:|---:|
| No evidence | 10.00 | 0.0% | 0.0% | 56.6 | 0.000 |
| Raw | 73.79 | 89.5% | 53.7% | 475.5 | 0.174 |
| Features | **97.90** | **100.0%** | **100.0%** | 840.8 | **1.189** |
| Raw + features | 79.52 | 95.3% | 55.6% | 1,159.7 | 0.562 |

The no-evidence arm receives 10 points only for avoiding hallucinated
endpoints; it has zero endpoint F1 and produces no complete contract.

Features-only is the best contract input. It produces 6.8 times as many
complete contracts per 1,000 prompt tokens as raw and 2.1 times as many as
raw+features. Raw uses fewer tokens per case, but its incomplete or noisy
contracts make that apparent saving ineffective.

## Per-version effectiveness

| Suite | Cases | Raw quality | Features quality | Raw+features quality | Features complete |
|---|---:|---:|---:|---:|---:|
| V1 | 3 | 71.35 | **100.00** | 80.00 | 100% |
| V2 | 3 | 71.35 | **100.00** | 80.00 | 100% |
| V3 | 3 | 71.35 | **100.00** | 80.00 | 100% |
| V4 | 1 | 54.50 | **100.00** | 54.50 | 100% |
| V5 | 12 | 67.74 | **100.00** | 76.79 | 100% |
| V6 | 21 | 82.43 | **100.00** | 89.89 | 100% |
| V7 | 40 | 82.38 | **100.00** | 97.86 | 100% |
| V8 | 25 | 85.34 | **100.00** | 86.67 | 100% |
| KeyManager | 1 | 77.71 | **81.14** | 70.00 | 100% |

For every Gym version, features-only reaches 100/100. Raw sometimes includes
telemetry endpoints or emits concrete observations where a reusable contract
needs a route template. Adding raw evidence to features is not consistently
helpful: it increases prompt size and can pull model attention back toward
noise.

KeyManager features-only covers all endpoints and exact statuses but scores
81.14 because the generated contract does not transcribe every observed
request and response field. It still outperforms both alternatives on the
combined field-aware quality score.

## Farmer rerun before generation

The source suites were regenerated with the current farmer:

| Farmer suite | Cross-session result |
|---|---:|
| V5 | 100/100; relation F1 100% |
| V6 | 100/100; relation recall 100% |
| V7 | 98.33/100; relation recall 92.9% |
| V8 | 100/100; 25/25 perfect cases |

V7 remains below 100 by design: character rotation is a held-out transform.
The farmer retains the unsupported relation as diagnostic evidence instead of
promoting it into the actionable contract context.

## KeyManager five-seed stability

KeyManager was rerun separately for five seeds and three evidence arms:

| Arm | Endpoint coverage | Exact statuses | No hallucination | Named `km_admin` cookie | Lifecycle dependencies | Mean prompt tokens |
|---|---:|---:|---:|---:|---:|---:|
| Raw | 100% | 100% | 100% | 0% | 100% | 18,046 |
| Features | 100% | 100% | 100% | **100%** | 100% | **12,691** |
| Raw + features | 100% | 100% | 100% | **100%** | 100% | 16,842 |

Features use 29.7% fewer prompt tokens than raw and 24.6% fewer than
raw+features. Raw never identifies the observed cookie transport or the
`km_admin` cookie, while both feature-bearing arms do so in every seed.

## Interpretation

- Farmed features improve contract completeness and factual attribution, not
  just prompt length.
- Raw evidence remains useful for audit and examples, but it is a poor default
  primary context for contract generation at larger suite sizes.
- Raw+features is not automatically stronger than features-only. Unranked raw
  observations add token cost and can reintroduce telemetry or concrete-value
  distractions.
- The best current policy is to feed the LLM the actionable farmed contract
  projection first and retrieve raw observations only for a specific
  uncertainty.
- Scores use the farmer's authoritative concrete inventory as the generation
  reference. The independent V5-V8 farmer benches remain necessary because
  the LLM matrix alone cannot detect an endpoint omitted by the farmer itself.

## Artifacts

- Full contract matrix: `generated/contract-matrix-rerun/matrix.md`
- Machine-readable matrix: `generated/contract-matrix-rerun/matrix.json`
- KeyManager five-seed matrix:
  `generated/contract-rerun-source/keymanager-multiseed/matrix.json`
- Runner: `scripts/run-contract-matrix.js`

Re-score existing model outputs after evaluator changes:

```powershell
$env:CONTRACT_MATRIX_RESCORE = '1'
npm run gym:contract-matrix
```

For a fresh end-to-end run, first run the canonical V5-V8 farmer commands and
`keymanager:contract-ab` so their manifests and redacted evidence exist. The
contract runner also accepts `CONTRACT_V5_MANIFEST`,
`CONTRACT_V6_MANIFEST`, `CONTRACT_V7_MANIFEST`,
`CONTRACT_V8_DATA_ROOT`, `CONTRACT_V8_FARM_ROOT`, and
`CONTRACT_KEYMANAGER_SOURCE` when preserving named reruns.
