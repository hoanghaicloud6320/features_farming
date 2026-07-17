# Farmer Gym A/B V5

- 12 cases across three validation axes.
- A: farmer output from the first five-iteration recording session.
- B: farmer output aggregated across three sessions / fifteen iterations.
- No Gemini generation or Gemini acceptance score is used.
- Farmer score: 25 endpoint core F1 + 15 noise recall + 20 ordered workflow recall + 40 relation F1.

| Case | Axis | A score | B score | A relation recall | B relation recall |
|---|---|---:|---:|---:|---:|
| simple-exact-noise | simple-noise | 92.00 | 100.00 | 100% | 100% |
| simple-base64-noise | simple-noise | 92.00 | 100.00 | 100% | 100% |
| simple-case-noise | simple-noise | 92.00 | 100.00 | 100% | 100% |
| simple-prefix-noise | simple-noise | 80.00 | 86.67 | 50% | 50% |
| hard-sha256-clean | hard-clean | 92.00 | 100.00 | 100% | 100% |
| hard-sha1-clean | hard-clean | 92.00 | 100.00 | 100% | 100% |
| hard-md5-clean | hard-clean | 92.00 | 100.00 | 100% | 100% |
| hard-sha256-nodelim-clean | hard-clean | 92.00 | 100.00 | 100% | 100% |
| hard-sha256-noise | hard-noise | 92.00 | 100.00 | 100% | 100% |
| hard-sha1-noise | hard-noise | 92.00 | 100.00 | 100% | 100% |
| hard-md5-noise | hard-noise | 92.00 | 100.00 | 100% | 100% |
| hard-sha256-candidate-noise | hard-noise | 92.00 | 100.00 | 100% | 100% |

## Aggregate A/B

| Arm | Mean score | Core F1 | Noise recall | Workflow recall | Relation F1 | Full relation cases |
|---|---:|---:|---:|---:|---:|---:|
| single | 91.00 | 100.0% | 100.0% | 100.0% | 77.5% | 11/12 |
| cross-session | 98.89 | 100.0% | 100.0% | 100.0% | 97.2% | 11/12 |

## Three validation axes

| Axis | Cases | A score | B score | A relation recall | B relation recall |
|---|---:|---:|---:|---:|---:|
| simple-noise | 4 | 89.00 | 96.67 | 87.5% | 87.5% |
| hard-clean | 4 | 92.00 | 100.00 | 100.0% | 100.0% |
| hard-noise | 4 | 92.00 | 100.00 | 100.0% | 100.0% |

## Guardrails

- Ground truth is defined by the Gym independently of the farmer output.
- The score measures extraction fidelity, not whether a downstream model can write working automation.
- Hash relations are tested candidates supported by repeated observations, not proof of source-code causality.
