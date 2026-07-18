# Public no-login contract and automation benchmark

Model: `gemini-3.1-flash-lite`

| Target | Arm | Contract quality | Executable readiness | Endpoint F1 | Exact statuses | Automation semantic | Output exact | Prompt tokens |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| quickmock-relay | none | 10.00 | 0.00 | 0.0% | 0.0% | FAIL | FAIL | 608 |
| quickmock-relay | raw | 77.50 | 100.00 | 100.0% | 100.0% | PASS | PASS | 3272 |
| quickmock-relay | features | 77.50 | 100.00 | 100.0% | 100.0% | PASS | PASS | 8932 |
| quickmock-relay | raw-features | 77.50 | 100.00 | 100.0% | 100.0% | PASS | PASS | 11632 |
| tryscrapeme-ajax | none | 10.00 | 0.00 | 0.0% | 0.0% | FAIL | FAIL | 633 |
| tryscrapeme-ajax | raw | 85.00 | 100.00 | 100.0% | 100.0% | PASS | PASS | 11191 |
| tryscrapeme-ajax | features | 85.00 | 100.00 | 100.0% | 100.0% | PASS | PASS | 3463 |
| tryscrapeme-ajax | raw-features | 85.00 | 100.00 | 100.0% | 100.0% | PASS | PASS | 10637 |
| webscraping-graphql | none | 0.00 | 0.00 | 0.0% | 0.0% | FAIL | FAIL | 639 |
| webscraping-graphql | raw | 85.00 | 100.00 | 100.0% | 100.0% | FAIL | FAIL | 22251 |
| webscraping-graphql | features | 85.00 | 100.00 | 100.0% | 100.0% | PASS | PASS | 5805 |
| webscraping-graphql | raw-features | 85.00 | 100.00 | 100.0% | 100.0% | PASS | PASS | 11395 |
| testpages-calculator | none | 0.00 | 0.00 | 0.0% | 0.0% | FAIL | FAIL | 680 |
| testpages-calculator | raw | 85.00 | 100.00 | 100.0% | 100.0% | PASS | PASS | 4426 |
| testpages-calculator | features | 85.00 | 100.00 | 100.0% | 100.0% | PASS | PASS | 3412 |
| testpages-calculator | raw-features | 85.00 | 100.00 | 100.0% | 100.0% | PASS | PASS | 7194 |
| testpages-products | none | 10.00 | 0.00 | 0.0% | 0.0% | FAIL | FAIL | 644 |
| testpages-products | raw | 82.69 | 77.78 | 100.0% | 100.0% | PASS | PASS | 14196 |
| testpages-products | features | 82.69 | 100.00 | 100.0% | 100.0% | PASS | PASS | 12298 |
| testpages-products | raw-features | 82.69 | 100.00 | 100.0% | 100.0% | FAIL | FAIL | 16624 |

## Clean-target summary

| Arm | Contract quality | Executable readiness | Endpoint F1 | Exact statuses | Automation semantic | Output exact | Tokens / target | Contract quality / 1k contract tokens |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| none | 6.00 | 0.00 | 0.0% | 0.0% | 0.0% | 0.0% | 640.8 | 19.32 |
| raw | 83.04 | 95.56 | 100.0% | 100.0% | 80.0% | 80.0% | 11067.2 | 15.03 |
| features | 83.04 | 100.00 | 100.0% | 100.0% | 100.0% | 100.0% | 6782.0 | 24.56 |
| raw-features | 83.04 | 100.00 | 100.0% | 100.0% | 80.0% | 80.0% | 11496.4 | 14.47 |

## No-evidence contamination gate

| Target | Contract route recall | Static route matches | Automation accepted | Gate |
|---|---:|---:|---:|---|
| quickmock-relay | 0.0% | 0 | no | CLEAN |
| tryscrapeme-ajax | 0.0% | 0 | no | CLEAN |
| webscraping-graphql | 0.0% | 0 | no | CLEAN |
| testpages-calculator | 0.0% | 0 | no | CLEAN |
| testpages-products | 0.0% | 0 | no | CLEAN |

A target is marked contaminated when the no-evidence contract or generated source contains an exact/stable internal route. Runtime discovery is reported separately from static prior-knowledge matches.
Contaminated targets are quarantined from the clean-target summary.

One fixed-seed trial is used per cell. This is a live diagnostic matrix, not a statistically powered benchmark.
