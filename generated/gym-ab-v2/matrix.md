# Local Gym A/B Matrix

- Model: `gemini-3.1-flash-lite`
- Design: 3 challenges × 4 evidence conditions × 1 fixed-seed trial
- Primary outcome: hidden server accepted the completed workflow.
- Score: 6 acceptance + 3 route coverage + 1 clean node:test exit.

| Challenge | Evidence | Accepted | Route coverage | Test | Score / 10 |
|---|---|---:|---:|---:|---:|
| easy | No evidence | no | 0% | fail | 0.00 |
| easy | Raw recorder | yes | 100% | pass | 10.00 |
| easy | Farmed features | yes | 100% | pass | 10.00 |
| easy | Raw + features | yes | 100% | pass | 10.00 |
| medium | No evidence | no | 0% | fail | 0.00 |
| medium | Raw recorder | yes | 100% | pass | 10.00 |
| medium | Farmed features | no | 0% | fail | 0.00 |
| medium | Raw + features | no | 0% | fail | 0.00 |
| hard | No evidence | no | 0% | fail | 0.00 |
| hard | Raw recorder | no | 100% | fail | 3.00 |
| hard | Farmed features | no | 67% | fail | 2.00 |
| hard | Raw + features | no | 0% | fail | 0.00 |

## Aggregate by evidence condition

| Evidence | Accepted workflows | Mean score |
|---|---:|---:|
| No evidence | 0/3 | 0.00 |
| Raw recorder | 2/3 | 7.67 |
| Farmed features | 1/3 | 4.00 |
| Raw + features | 1/3 | 3.33 |

## Interpretation guardrails

- The website and opaque routes were created immediately before this run; the model received no browsing tools or source code.
- The raw arm receives a transport-noise-reduced HTTP timeline projection, but no inferred relation labels.
- This run has one fixed-seed trial per cell. It is a real execution matrix, not a statistically powered model benchmark.
- A hidden server metric prevents code that merely exits cleanly from being counted as successful.
