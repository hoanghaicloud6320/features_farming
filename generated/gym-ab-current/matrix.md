# Local Gym A/B Matrix

- Model: `gemini-3.1-flash-lite`
- Design: 4 challenges × 4 evidence conditions × 1 fixed-seed trial(s)
- Evidence budget: 24000 JSON characters per cell
- Primary outcome: hidden server accepted the completed workflow.
- Score: 6 acceptance + 3 route coverage + 1 clean node:test exit.

| Challenge | Trial | Evidence | Accepted | Route coverage | Requests | Score / 10 |
|---|---:|---|---:|---:|---:|---:|
| easy | 1 | No evidence | no | 0% | 0 | 0.00 |
| easy | 1 | Raw recorder | yes | 100% | 2 | 10.00 |
| easy | 1 | Farmed features | yes | 100% | 2 | 10.00 |
| easy | 1 | Raw + features | yes | 100% | 2 | 10.00 |
| medium | 1 | No evidence | no | 0% | 0 | 0.00 |
| medium | 1 | Raw recorder | yes | 100% | 2 | 10.00 |
| medium | 1 | Farmed features | yes | 100% | 2 | 10.00 |
| medium | 1 | Raw + features | yes | 100% | 2 | 10.00 |
| hard | 1 | No evidence | no | 0% | 0 | 0.00 |
| hard | 1 | Raw recorder | no | 67% | 2 | 2.00 |
| hard | 1 | Farmed features | yes | 100% | 3 | 10.00 |
| hard | 1 | Raw + features | yes | 100% | 3 | 10.00 |
| noise | 1 | No evidence | no | 0% | 0 | 0.00 |
| noise | 1 | Raw recorder | no | 100% | 3 | 3.00 |
| noise | 1 | Farmed features | yes | 100% | 2 | 10.00 |
| noise | 1 | Raw + features | no | 100% | 2 | 3.00 |

## Aggregate by evidence condition

| Evidence | Accepted workflows | Mean score | Mean requests | Mean prompt tokens |
|---|---:|---:|---:|---:|
| No evidence | 0/4 | 0.00 | 0.00 | 356 |
| Raw recorder | 2/4 | 6.25 | 2.25 | 9547 |
| Farmed features | 4/4 | 10.00 | 2.25 | 11958 |
| Raw + features | 3/4 | 8.25 | 2.25 | 13170 |

## Interpretation guardrails

- The website and opaque routes were created immediately before this run; the model received no browsing tools or source code.
- The raw arm receives a transport-noise-reduced HTTP timeline projection, but no inferred relation labels.
- This run has 1 fixed-seed trial(s) per cell.
- A hidden server metric prevents code that merely exits cleanly from being counted as successful.
