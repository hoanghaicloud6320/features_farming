# Is the farmer useful?

## Verdict

Yes, within a bounded role. The farmer is useful as a deterministic evidence
indexer and compressor. It is not a replacement for raw recordings, and its
relation labels are hypotheses supported by observations rather than proof of
application source-code causality.

The strongest evidence is the five-seed KeyManager experiment:

| Evidence | Endpoint/status accuracy | Correct `km_admin` cookie auth | Lifecycle dependencies | Mean prompt tokens |
|---|---:|---:|---:|---:|
| Raw | 100% | 0/5 | 5/5 | 18,046 |
| Farmer features | 100% | 5/5 | 5/5 | 12,407 |
| Raw + features | 100% | 5/5 | 5/5 | 16,933 |

The model output text changed across seeds, but these measured facts were
stable. Features used 31.3% fewer prompt tokens than raw and made the
authentication transport consistently visible. Combining raw and features
cost 36.5% more tokens than features alone without improving the measured
facts.

## Where it helps

- It pre-joins response values to later request fields, so the model receives
  ranked relationships instead of searching a Cartesian product.
- It preserves concrete sibling provenance: status, schema, fields, and
  session/iteration support remain attributable after route generalization.
- It filters repeated telemetry while retaining a compact endpoint inventory.
- Cross-session support rejects accidental relations that occur in only one
  session.
- It produces explicit negative information and warnings when attribution is
  incomplete.

The post-detector V6 result reached 100/100 cross-session on 21 cases. A V7
rerun with five fresh seeds retained 100% relation recall on all six supported
families, exact semantic-sibling attribution, and exact endpoint/noise/workflow
metrics.

## Where it can hurt

- Any compaction can remove rare but real behavior. Raw remains the audit
  source when completeness matters more than attention cost.
- Repeated correlation is not causality. An initial affine detector promoted
  KeyManager counters that happened to move together with the scripted
  iteration. All six fits are now retained as diagnostic hypotheses, with
  limited-diversity/common-cause risks, but excluded from actionable contract
  data flows.
- Unsupported transforms are omitted. In V7 the new character-rotation
  holdout remained undiscovered: recall was 50% because the ordinary `runId`
  relation was found and the held-out transform was not.
- A wrong generalized route can mix semantic siblings. Member-level provenance
  and attribution warnings reduce this risk, but do not make every route
  generalization correct.
- Farming adds CPU time and implementation complexity. On the 159-request
  KeyManager recording the current local refarm took about 15 seconds.

Importantly, the V7 character-rotation holdout had relation precision 100% in
all five seeds. The farmer did not invent a supported transform; it exposed a
known gap. This is preferable to asking the LLM to guess.

## Safe operating model

1. Keep raw recordings as the source of truth and reproducibility artifact.
2. Use farmer features as the primary model context when their support and
   attribution are sufficient.
3. Surface bounded deterministic matches with support counts and a
   non-causality warning.
4. Use raw snippets only for unresolved or low-support areas rather than
   attaching the full raw timeline by default.
5. Validate every new detector on fresh seeds, real recordings, and at least
   one unsupported holdout family.

## Candidate inventory versus attention

The farmer now writes two separate relation layers:

- `relations.candidates*.json` retains bounded transform fits and relations
  even when they occur in only one session or have insufficient input
  diversity.
- `relations*.json` contains only relations promoted for workflow,
  automation hints, and contract-oriented model context.

On the current KeyManager recording this produces 3,684 cross-session
candidates. Of these, 2,143 remain diagnostic-only: 2,137 lack repeated
cross-session support and six are low-diversity affine fits. The contract
prompt receives none of those 2,143 relations; it receives only their count
and a pointer to the diagnostic artifact.
