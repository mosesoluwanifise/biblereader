# Supertonic five-step quality and timing gate

Complete this artifact before setting
`VITE_SUPERTONIC_FIVE_STEP_QUALITY_APPROVED` to a model version. An empty or
mismatched value keeps eight steps active and clears persisted five-step
state before load.

## Build identity

- Date:
- Reviewer(s):
- Git commit:
- Model manifest version:
- ONNX Runtime version:
- Browser/version:
- OS and named hardware class:
- Provider (`webgpu` or `wasm`):
- Cross-origin isolated (`true`/`false`):
- Capability fingerprint from qualification JSON:
- Voice IDs and speed(s):
- Random seeds/draw count, if controlled:

## Blind listening comparison

Use the same representative passages and voices for five and eight steps.
Include prose, poetry, short verses, punctuation, names, all-caps source text,
and a long packed chunk. Do not place licensed Scripture text in diagnostic
JSON; keep the listening set and resulting audio in the controlled release
artifact location.

| Sample ID | Preferred | Five-step artifacts or pronunciation defects | Eight-step defects | Accept five steps? |
| --- | --- | --- | --- | --- |
| | | | | |

Acceptance decision and reviewer rationale:

## Highlight timing comparison

Measure first-word onset, internal packed-sentence transitions, final-word
end, and full-chapter accumulated drift against the agreed release tolerance.

| Sample ID | Steps | Max absolute error | Packed transition error | End drift | Pass? |
| --- | ---: | ---: | ---: | ---: | --- |
| | 5 | | | | |
| | 8 | | | | |

## Performance evidence

Attach `supertonic-qualification.json` for both step counts. Production factor
means audio seconds divided by end-to-end prepared-chunk wall time, including
packed-segment duration predictions; higher is better.

| Steps | Provider | 10+ raw warm scheduled-onset samples | Nearest-rank p95 | Synthesis ms p50/p95/p99 | Production factor p50/p95/p99 | Peak aggregate PCM | Min ahead | Underruns / duration |
| ---: | --- | --- | ---: | --- | --- | ---: | ---: | --- |
| 5 | | | | | | | | |
| 8 | | | | | | | | |

The automated onset is the controller observing its AudioContext clock reach
the first scheduled speech boundary; it is not a microphone measurement of
physical speaker output. Attach the raw observations, not only the percentile.

For each supported class, attach three complete long-chapter passes. The final
pass uses the harness's bounded main-thread jitter profile. Automated evidence
must contain the exact monotonic `0..wordCount-1` highlighted global-index
sequence with no skipped or repeated transitions. The current UI does not
expose scheduled per-word audio boundaries, so automated DOM timestamps cannot
establish audible timing error or drift; complete the manual timing comparison
above against physical output.

## Decision

- [ ] Listening comparison passes.
- [ ] Timing comparison passes.
- [ ] At least ten raw warm current-passage observations are attached and nearest-rank p95 is <=3 s; primed navigation is <=3 s.
- [ ] Named supported classes complete three long-chapter passes (including controlled jitter) with zero synthesis underruns and exact highlight-index order.
- [ ] WebGPU, forced-WASM, and initialization-fallback outcomes are attached.
- [ ] Mid-session WebGPU device-loss manual profile reaches a retryable state.
- [ ] Approval value exactly equals the model manifest version.

Final decision: **approved / rejected**

Approver and date:

Rollback: remove or change `VITE_SUPERTONIC_FIVE_STEP_QUALITY_APPROVED` and
redeploy. The next engine load rejects and clears any persisted five-step
profile; eight-step profiles are unaffected.

Independent rollout switches: set
`VITE_SUPERTONIC_PROVIDER_FALLBACK_ENABLED=0` to disable alternate-provider
fallback, or `VITE_SUPERTONIC_SPECULATIVE_PREPARATION=0` to disable passage
speculation. Record their exact deployed values with the artifact. An empty
template, skipped project, smoke run, or incomplete long pass is not a pass.
