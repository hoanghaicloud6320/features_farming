# Contract generation matrix

Model: `gemini-3.1-flash-lite`

| Suite | Arm | Cases | Quality /100 | Endpoint F1 | Exact statuses | Complete cases | Tokens/case | Latency s | Complete cases / 1k tokens |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| v1 | none | 3 | 10.00 | 0.0% | 0.0% | 0.0% | 72.7 | 1.58 | 0 |
| v1 | raw | 3 | 71.35 | 100.0% | 0.0% | 0.0% | 190.7 | 2.61 | 0 |
| v1 | features | 3 | 100.00 | 100.0% | 100.0% | 100.0% | 402 | 4.29 | 2.488 |
| v1 | raw-features | 3 | 80.00 | 100.0% | 0.0% | 0.0% | 520 | 3.50 | 0 |
| v2 | none | 3 | 10.00 | 0.0% | 0.0% | 0.0% | 72.7 | 1.28 | 0 |
| v2 | raw | 3 | 71.35 | 100.0% | 0.0% | 0.0% | 190.7 | 3.15 | 0 |
| v2 | features | 3 | 100.00 | 100.0% | 100.0% | 100.0% | 402 | 3.40 | 2.488 |
| v2 | raw-features | 3 | 80.00 | 100.0% | 0.0% | 0.0% | 520 | 3.58 | 0 |
| v3 | none | 3 | 10.00 | 0.0% | 0.0% | 0.0% | 72.7 | 1.49 | 0 |
| v3 | raw | 3 | 71.35 | 100.0% | 0.0% | 0.0% | 190.7 | 2.79 | 0 |
| v3 | features | 3 | 100.00 | 100.0% | 100.0% | 100.0% | 402 | 3.40 | 2.488 |
| v3 | raw-features | 3 | 80.00 | 100.0% | 0.0% | 0.0% | 520 | 3.59 | 0 |
| v4 | none | 1 | 10.00 | 0.0% | 0.0% | 0.0% | 182 | 1.04 | 0 |
| v4 | raw | 1 | 54.50 | 80.0% | 0.0% | 0.0% | 422 | 2.09 | 0 |
| v4 | features | 1 | 100.00 | 100.0% | 100.0% | 100.0% | 544 | 2.27 | 1.838 |
| v4 | raw-features | 1 | 54.50 | 80.0% | 0.0% | 0.0% | 784 | 2.46 | 0 |
| v5 | none | 12 | 10.00 | 0.0% | 0.0% | 0.0% | 43.6 | 2.60 | 0 |
| v5 | raw | 12 | 67.74 | 71.4% | 83.3% | 25.0% | 314.3 | 14.56 | 0.796 |
| v5 | features | 12 | 100.00 | 100.0% | 100.0% | 100.0% | 1017.5 | 15.22 | 0.983 |
| v5 | raw-features | 12 | 76.79 | 85.7% | 100.0% | 33.3% | 1288.2 | 15.92 | 0.259 |
| v6 | none | 21 | 10.00 | 0.0% | 0.0% | 0.0% | 56.3 | 3.50 | 0 |
| v6 | raw | 21 | 82.43 | 81.1% | 100.0% | 0.0% | 316.1 | 28.07 | 0 |
| v6 | features | 21 | 100.00 | 100.0% | 100.0% | 100.0% | 749 | 22.49 | 1.335 |
| v6 | raw-features | 21 | 90.60 | 100.0% | 100.0% | 100.0% | 1008.8 | 18.27 | 0.991 |
| v7 | none | 40 | 10.00 | 0.0% | 0.0% | 0.0% | 52.3 | 5.50 | 0 |
| v7 | raw | 40 | 82.38 | 81.0% | 100.0% | 0.0% | 313.4 | 51.22 | 0 |
| v7 | features | 40 | 100.00 | 100.0% | 100.0% | 100.0% | 731.5 | 51.15 | 1.367 |
| v7 | raw-features | 40 | 80.24 | 81.0% | 100.0% | 0.0% | 992.5 | 49.18 | 0 |
| v8 | none | 25 | 10.00 | 0.0% | 0.0% | 0.0% | 53.3 | 3.83 | 0 |
| v8 | raw | 25 | 85.34 | 91.7% | 100.0% | 20.0% | 423.9 | 31.18 | 0.472 |
| v8 | features | 25 | 100.00 | 100.0% | 100.0% | 100.0% | 942.6 | 41.40 | 1.061 |
| v8 | raw-features | 25 | 100.00 | 100.0% | 100.0% | 100.0% | 1313.2 | 37.08 | 0.761 |
| keymanager | none | 1 | 10.00 | 0.0% | 0.0% | 0.0% | 201 | 1.04 | 0 |
| keymanager | raw | 1 | 80.71 | 100.0% | 100.0% | 100.0% | 14871 | 3.23 | 0.067 |
| keymanager | features | 1 | 89.51 | 100.0% | 100.0% | 100.0% | 9130 | 4.11 | 0.11 |
| keymanager | raw-features | 1 | 86.73 | 100.0% | 100.0% | 100.0% | 10720 | 5.32 | 0.093 |

Quality weights: endpoint F1 40%, exact status sets 20%, request-field recall 15%, response-field recall 15%, and no hallucinated endpoints 10%.

Complete-contract token efficiency is the number of cases with full endpoint coverage, exact status sets, and no hallucinated endpoints per 1,000 prompt tokens. Quality points per 1,000 tokens remain available in matrix.json.

V1, V2, and V3 intentionally share the original three recordings but use different model seeds. This measures generation variance without pretending they are distinct datasets.
