# Farmer Gym A/B V5

## Objective

V5 evaluates the farmer itself. Gemini is not called and downstream generated
automation is not part of the score.

The benchmark contains 12 newly recorded localhost cases:

| Axis | Cases | Purpose |
|---|---:|---|
| Simple transform + high noise | 4 | Exact copy, base64url, case normalization, and prefixing among 24 telemetry calls and 36-48 candidates per iteration |
| Hard transform + low noise | 4 | SHA-256, SHA-1, and MD5 relations with varied field order, delimiters, and digest slicing |
| Hard transform + high noise | 4 | The same class of difficult relations among 30-36 telemetry calls and 48-64 candidates per iteration |

Each case is recorded for three independent sessions with five iterations per
session. Ground truth lives in the Gym definitions, independently from the
farmer output.

## A/B definition

- **A — single session:** farmer output from the first five-iteration session.
- **B — cross-session:** farmer output aggregated across all three sessions and
  fifteen iterations.

The first session deliberately contains one stable accidental collision. The
collision is broken in sessions two and three. This makes the A/B comparison
measure whether cross-session aggregation rejects a plausible false relation.

## Farmer score

The 100-point score is:

- 25 points: F1 for classifying core endpoints;
- 15 points: recall for classifying telemetry/noise endpoints;
- 20 points: ordered workflow recall;
- 40 points: F1 for required core-to-core relations and transformations.

Valid relations originating from telemetry are excluded from relation
precision because they are filtered from the farmer's automation-oriented
feature context.

## Result

| Arm | Mean score | Core F1 | Noise recall | Workflow recall | Relation F1 | Cases with all required relations |
|---|---:|---:|---:|---:|---:|---:|
| A: single session | 91.00 | 100% | 100% | 100% | 77.5% | 11/12 |
| B: cross-session | **98.89** | **100%** | **100%** | **100%** | **97.2%** | **11/12** |

Cross-session farming removes the deliberate session-one collision in all
cases, increasing mean score by 7.89 points and relation F1 by 19.7 percentage
points.

| Axis | Cases | A mean | B mean | B required-relation recall |
|---|---:|---:|---:|---:|
| Simple + noise | 4 | 89.00 | 96.67 | 87.5% |
| Hard + clean | 4 | 92.00 | 100.00 | 100% |
| Hard + noise | 4 | 92.00 | 100.00 | 100% |

## Farmer gap found

The only missed decisive relation is the prefix case:

```text
open.response.token
  -> close.request.proof = "MARKER-" + token
```

The current substring detector restricts body-field candidates using semantic
field-name hints. A target named `proof` is not included in that allowlist, so
the relation is missed even though the transform is simple and repeated in all
15 iterations.

This is a useful V5 failure: it identifies a farmer recall limitation rather
than a downstream model failure. The canonical result intentionally preserves
the miss instead of changing the farmer and tuning against the same V5 cases.

## Reproduce

```powershell
npm install
npm run gym:v5
```

Optional controls:

```powershell
$env:GYM_V5_SESSIONS = "3"
$env:GYM_V5_ITERATIONS = "5"
$env:GYM_V5_OUTPUT = "generated/gym-ab-v5-repeat"
npm run gym:v5
```

Runtime recordings and full farm reports are stored under timestamped
`demo-data/gym-v5/` and `output/gym-v5/` directories and remain ignored by
Git. The portable result matrix is stored under `generated/gym-ab-v5/`.

## Interpretation guardrails

- Hash-derived relations are bounded tested candidates, not proof of program
  causality.
- The cases are synthetic and exercise transformations the current farmer is
  designed to search.
- V5 measures extraction fidelity and cross-session stability. It does not
  estimate the success rate of a downstream automation model.
