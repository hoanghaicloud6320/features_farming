# Farmer executable-evidence upgrade: before and after

Date: 2026-07-18
Model: `gemini-3.1-flash-lite`
Trial design: one fixed-seed generation per cell

## What changed

The upgrade implements seven changes:

1. Response JSON is detected from payload content as well as media type/file
   extension.
2. JSON scalars and plain-text response representations retain root kind, media
   type, parser guidance, and bounded examples.
3. Compact automation hints are included in cross-session LLM evidence.
4. Request literals become role-aware replay profiles. Stable values are
   parameterized observed defaults, never asserted hardcoded requirements.
5. Repeated same-endpoint occurrences are preserved. Ordered constant copies
   remain candidate traces while diverse-value relations remain confirmed flows.
6. Contract inventory quality and executable-contract readiness are scored
   separately.
7. Automation semantic success and exact output-schema compliance are scored
   separately.

The collection harness now waits for entry-page traffic to settle and keeps an
iteration open across the target's required crawl delay.

## Fair four-target comparison

The original clean aggregate excluded GraphQL as contaminated, so the fairest
before/after comparison uses the four targets common to both clean sets:

- random MockServer relay
- TryScrapeMe AJAX
- TestPages calculator
- TestPages products

| Arm | Contract quality before | Contract quality after | Exact automation before | Exact automation after | Tokens/target before | Tokens/target after |
|---|---:|---:|---:|---:|---:|---:|
| raw | 82.55 | 82.55 | 75% | 100% | 8,187.8 | 8,271.3 |
| features | 79.17 | 82.55 | 50% | 100% | 4,271.3 | 7,026.3 |
| raw-features | 82.55 | 82.55 | 75% | 75% | 9,108.8 | 11,521.8 |

Interpretation:

- Feature contract quality gained 3.38 points because text-served JSON response
  fields are now preserved.
- Feature exact automation gained 50 percentage points.
- Half of that strict gain is output-shape clarification on TryScrapeMe; the
  farmer-specific semantic gain is from 75% to 100%, primarily the calculator
  scalar representation.
- Richer features cost more tokens. On the common set they remain about 15%
  smaller than raw; on the post-fix five-target run they are about 39% smaller.
- The post-fix raw-features product failure is a Gemini constraint violation:
  it imported forbidden `node:fetch`. The endpoint, contract and evidence were
  correct.

## Post-fix five-target result

All five no-evidence arms were clean in this run. The random relay remains the
strongest anti-contamination control because its paths are created at runtime.

| Arm | Contract quality | Executable readiness | Semantic automation | Exact output | Tokens/target |
|---|---:|---:|---:|---:|---:|
| none | 6.00 | 0.00 | 0% | 0% | 640.8 |
| raw | 83.04 | 95.56 | 80% | 80% | 11,067.2 |
| features | 83.04 | 100.00 | 100% | 100% | 6,782.0 |
| raw-features | 83.04 | 100.00 | 80% | 80% | 11,496.4 |

The two non-feature failures were generated-code policy failures:

- GraphQL/raw imported `node:fetch`.
- Products/raw-features imported `node:fetch`.

Both are Gemini failures rather than farmer information failures. A targeted
GraphQL validation immediately afterward produced passing raw, features and
raw-features automation, demonstrating that a single fixed-seed call is not a
statistically stable estimate.

## GraphQL flow validation

After waiting for entry-page traffic before starting an iteration:

- captured workflow requests: 12, exactly 2 sessions × 3 iterations × 2 calls
- workflow: occurrence 1 followed by occurrence 2
- false polling count: 0
- repeated-call observations: 6
- replay value: `variables.first = 20`, marked `observed-stable`,
  `parameterize: true`
- cursor trace:
  `response.data.reviews.pageInfo.endCursor → request.variables.after`
- trace support: 2 sessions, 6 iterations, median request distance 1
- distinct cursor values: 1, therefore status remains `candidate`, not confirmed
  causality

Targeted result:

| Arm | Contract quality | Executable readiness | Automation | Tokens |
|---|---:|---:|---:|---:|
| raw | 85.00 | 100.00 | PASS | 22,267 |
| features | 86.67 | 100.00 | PASS | 5,621 |
| raw-features | 85.00 | 100.00 | PASS | 11,201 |

## Conclusion

The earlier contract/automation gap was real but mixed three effects:

- the old contract metric did not measure execution-critical representation;
- farmer projection discarded response and replay semantics;
- strict output naming and occasional Gemini policy violations inflated the
  apparent automation failure rate.

After separating those concerns, farmed features are sufficient for all five
automations in the full run and use materially fewer tokens than raw. This is
still a diagnostic result, not a claim of general superiority; multi-seed runs
are required for confidence intervals.
