# Public no-login contract and automation benchmark

> This document is the pre-upgrade baseline. See
> `PUBLIC_NO_LOGIN_BEFORE_AFTER.md` for the post-fix rerun and comparison.

Run date: 2026-07-18
Model: `gemini-3.1-flash-lite`
Runtime: Node.js 20+ built-in `fetch` only

## Scope

The benchmark uses public targets that are explicitly intended for scraping,
testing, or mock API practice:

- TryScrapeMe AJAX challenge
- TestPages calculator API
- TestPages product count/list/detail flow
- web-scraping.dev GraphQL pagination
- a two-step MockServer relay provisioned at fresh, random URLs for every run

Every target has a `none` arm. A target is quarantined when that arm recalls an
exact/stable internal route, even if its generated automation does not complete.
The fresh MockServer relay is the strongest negative control because its two
routes and handoff values do not exist until the run starts.

The harness records 2 independent browser sessions with 3 iterations per target,
farms the recordings, then feeds Gemini the same four-arm matrix:

1. `none`
2. `raw`
3. `features`
4. `raw-features`

## Clean-target results

The GraphQL target was quarantined because the no-evidence source recalled
`/api/graphql`. The aggregate below therefore includes only the other four
targets.

| Arm | Contract quality | Endpoint F1 | Exact statuses | Automation pass | Tokens / target | Contract quality / 1k contract tokens |
|---|---:|---:|---:|---:|---:|---:|
| none | 10.00 | 0.0% | 0.0% | 0.0% | 554.3 | 44.30 |
| raw | 82.55 | 100.0% | 100.0% | 75.0% | 8,187.8 | 20.42 |
| features | 79.17 | 100.0% | 100.0% | 50.0% | 4,271.3 | 37.99 |
| raw-features | 82.55 | 100.0% | 100.0% | 75.0% | 9,108.8 | 18.33 |

## Interpretation

- Contract generation is effective in every evidence arm: endpoint F1 and exact
  status accuracy are both 100% on the clean targets.
- `raw` and `raw-features` tie on quality and strict automation success. Adding
  features to raw traffic costs 11.2% more prompt tokens without improving the
  outcome in this run.
- `features` uses 47.8% fewer prompt tokens than `raw`, while retaining 95.9% of
  raw's contract-quality score. It is the strongest contract-only efficiency
  point, at 37.99 quality points per 1,000 contract prompt tokens.
- For strict end-to-end automation, `raw` is the current default: 75% pass versus
  50% for features. The failures expose lost value/schema details rather than
  missed routes.
- TryScrapeMe automation computed the correct count and price sum in every
  evidence arm, but failed the strict result-object field names. The next run's
  prompt now specifies the exact JSON shape, so this formatting ambiguity is no
  longer part of the task.
- The no-evidence arms scored 0% endpoint F1 and 0% automation success on all four
  clean targets. The fresh random relay also failed without evidence and passed
  with every evidence type, which is the clearest anti-contamination result.

## Operating constraints

- No target requires login, cloning, building, or starting a local server.
- Generated scripts are statically checked and may only use built-in Node.js
  capabilities, the target origin, and at most eight HTTP requests.
- web-scraping.dev requests are spaced by at least 2.1 seconds to comply with its
  published `Crawl-delay: 2`.
- A target marked contaminated is excluded from the clean aggregate rather than
  silently counted.
- This is one fixed-seed trial per cell. Use multiple seeds before treating small
  arm differences as statistically stable.

## Re-run

```powershell
npm run gym:public-no-login
```

Optional controls:

```powershell
$env:PUBLIC_BENCH_TARGETS='quickmock-relay,tryscrapeme-ajax'
$env:PUBLIC_BENCH_SESSIONS='2'
$env:PUBLIC_BENCH_ITERATIONS='3'
npm run gym:public-no-login
```

Refresh only the Markdown and aggregate fields from the existing matrix:

```powershell
$env:PUBLIC_BENCH_REPORT_ONLY='1'
npm run gym:public-no-login
```
