# Caption translation plan

## Goal

Add local, offline translation of live captions to PiVoice.

PiVoice already owns the incoming transcript/caption flow and its distribution to consumers. Translation should extend that existing lifecycle rather than introduce a second service that independently manages caption tracks.

The design has four responsibilities:

- **PiVoice:** owns caption tracks, translation-track lifecycle, orchestration, status, retries, alignment and publication.
- **fffleet:** queues and schedules translation jobs and selects a capable worker.
- **Translation worker:** performs text translation using locally installed models; it does not know about recordings, caption tracks or publication.
- **Operator PC:** runs the translation worker and supplies the CPU/RAM/storage for translation inference, keeping that workload off the Raspberry Pi.

The initial implementation should use fffleet's existing custom-executor mechanism. No fffleet core changes are expected unless implementation testing reveals a concrete gap.

## Architectural decision: lifecycle belongs in PiVoice

Do not implement a separate long-running PiTranslate HTTP service for caption translation.

PiVoice is the authoritative owner of the caption lifecycle. It receives and maintains the original transcript, creates or updates translated caption tracks, submits translation work, associates results with their source segments, and publishes the resulting tracks to the appropriate consumers.

The translation worker is deliberately narrower: it accepts text segments and language direction, translates them, and returns the translated text with the original segment identifiers.

A reusable translation engine or model-management module may be extracted later if another application needs it. That does not justify a separate caption lifecycle or network service now. The existing PiTranslate repository can remain an experiment or future reusable component; it is not a runtime dependency of this design.

## Language policy

### Supported source languages

Only these source languages are supported initially:

- Finnish: `fi`
- English: `en`
- Swedish: `sv`

Do not accept Russian, Ukrainian, Spanish or arbitrary other languages as source languages in this initial scope. Do not silently expand source-language support through model availability or language auto-detection.

The source language must be known from the existing transcription/session configuration or explicitly supplied to the translation workflow. Translation is not responsible for detecting or correcting the source language.

### Initial target languages

The initial configurable target-language set is:

- Finnish: `fi`
- English: `en`
- Swedish: `sv`
- Russian: `ru`
- Ukrainian: `uk`
- Spanish: `es`

Do not translate a language into itself. Same-language requests should be rejected as invalid or represented explicitly as a no-op; they must not be submitted to a worker.

This gives the following possible directions:

| Source | Allowed targets |
| --- | --- |
| Finnish (`fi`) | `en`, `sv`, `ru`, `uk`, `es` |
| English (`en`) | `fi`, `sv`, `ru`, `uk`, `es` |
| Swedish (`sv`) | `fi`, `en`, `ru`, `uk`, `es` |

These are policy-allowed directions, not a promise that every direction is immediately available. A direction is available only when a compatible model is installed, tested and ready on a worker.

Do not silently translate through an intermediate language. A worker must provide the requested source-to-target direction directly.

## Component responsibilities

### PiVoice — caption and translation lifecycle

PiVoice remains the system of record for caption tracks and their relationships.

It is responsible for:

- Receiving and maintaining the original transcript/caption segments.
- Maintaining the source language and source-track identity/version.
- Determining which target-language tracks are requested or enabled.
- Creating and tracking a separate translated track for each target language.
- Batching eligible source segments and submitting translation jobs to fffleet.
- Tracking pending, running, completed and failed translation work.
- Matching returned translations to the original segment IDs.
- Preserving segment order, timing and other caption metadata.
- Publishing translated tracks through the existing caption distribution paths.
- Retrying eligible failures with bounded retry policy.
- Detecting stale translations when the source transcript changes and scheduling replacements.
- Exposing translation availability and status to existing PiVoice consumers and operator interfaces.

Translation must not block original caption delivery. A missing, delayed or failed translation must never stop the original transcript, radio, capture or other caption consumers.

PiVoice should keep the original caption track intact. Translations are additional tracks, not replacements for the source.

### fffleet — job scheduling

Use fffleet's existing custom job executor support.

- Use one executor type named `translate` for all language directions.
- Express each direction as a worker capability, for example `translate:fi-en`, `translate:fi-sv` or `translate:sv-uk`.
- A worker advertises only directions for which it has a compatible, installed, tested and ready model.
- Use job requirements to ensure that only a worker advertising the requested direction can receive the job.
- Configure the PiVoice translation client with `fallback: 'none'`. A fleet outage must not cause translation inference to fall back onto the Raspberry Pi.
- Prefer the designated operator-PC worker through fffleet's worker preference/configuration when that worker is the intended execution host. If no eligible worker is available, the job should remain queued or reach a controlled failure state; it must not execute on an unintended host.

The worker protocol and custom executor should honour cancellation and job timeouts.

### Translation worker — model inference

Run the translation worker on the adjacent operator PC, not on the Raspberry Pi.

The worker is responsible for:

- Loading the configured translation executor.
- Discovering and validating locally installed models.
- Advertising only the language-direction capabilities it can actually serve.
- Loading a model when needed and unloading or switching models according to a bounded resource policy.
- Translating the supplied segments.
- Returning results keyed by the input segment IDs.
- Reporting clear errors for unsupported directions, unavailable models, invalid input and inference failures.
- Honouring fffleet cancellation and timeout signals.

The worker must not own caption-track state, session state, source transcript history, retry policy or publication. It should not retain caption content beyond what is required to execute the job.

## Translation job contract

Submit a batch job with the common executor type `translate`. The language direction is represented in both the payload and the required capability so that the scheduler can select a suitable worker.

Illustrative job:

```js
await fleet.submit({
  id: 'captions-sermon-123-fi-en',
  kind: 'batch',
  type: 'translate',
  requires: ['translate:fi-en'],
  translate: {
    source: 'fi',
    target: 'en',
    segments: [
      { id: 1, text: 'Tervetuloa jumalanpalvelukseen.' },
      { id: 2, text: 'Aloitamme yhteisellä virrellä.' }
    ]
  }
});
```

Illustrative result:

```json
{
  "translations": [
    { "id": 1, "text": "Welcome to the service." },
    { "id": 2, "text": "We begin with a hymn." }
  ]
}
```

The exact fffleet submission and result envelope must be checked against the version used by PiVoice during implementation. The example describes the logical contract, not a claim that these exact fields have already been implemented.

Contract requirements:

- Every input segment has a stable ID.
- Every output translation refers to exactly one input segment ID.
- Output ordering must not be relied upon; PiVoice matches by ID.
- The worker returns translated text, not rewritten timestamps or newly invented segment IDs.
- PiVoice retains ownership of timing, ordering, speaker metadata and caption formatting.
- Validate that the result contains the expected IDs and no duplicates or unknown IDs.
- Keep batches bounded by segment count and text size.
- Do not put credentials or unrelated session data in the job payload.
- Avoid logging caption text or full job payloads.

Use fffleet's inline output mechanism for these small text results where supported; there is no need to send translated caption text through object storage.

## Caption track lifecycle

Each translated track should have its own identity and metadata, including at least:

- Its own track ID.
- The source caption track ID and source revision/version.
- Source language and target language.
- Translation status: pending, running, completed or failed.
- The model identifier/version used for the translation.
- Creation/update timestamps and relevant failure information.

The source track remains authoritative.

When the source transcript changes, translations based on an older source revision become stale. PiVoice must not present stale translations as if they correspond to the current source. It should identify the affected segments or track revision and schedule the necessary translation work again.

Where practical, translate only changed or not-yet-translated segments. Preserve the association between translated segments and their source segments so that updates do not break caption timing or alignment.

A translation failure is isolated to the affected target track/job. Other target languages and the original caption track continue normally.

## Model and runtime strategy

The initial runtime should be local and offline. No external translation APIs, hosted inference services or cloud fallback are part of this plan.

Models must be installed and validated before they are advertised as available. Do not download models during a live service or normal translation request.

Candidate model families discussed include directional OPUS-MT/Marian models and multilingual alternatives. Model selection remains an implementation decision and must consider:

- Coverage of the required direct language directions.
- Translation quality for spoken Finnish, English and Swedish, including religious and service vocabulary.
- Model licence and suitability for the organisation's intended use.
- Model storage size and runtime memory use.
- Inference latency and throughput on the actual operator PC.
- Compatibility with the chosen Node.js inference runtime and its supported model formats.

Directional models must be treated as directional: a Finnish-to-English model does not imply English-to-Finnish support.

Transformers.js with ONNX Runtime is a candidate Node.js runtime, not yet a verified implementation decision. Confirm model export/format compatibility, Linux dependencies and the target machine's runtime behaviour before committing to it. Do not assume that a Python Hugging Face model can be loaded directly by the Node.js runtime.

Model file size is not the same as runtime RAM usage. Benchmark actual peak memory, load time, translation latency and sustained throughput on the operator PC. Do not advertise a capability until its model has passed these checks.

## Security, privacy and reliability

- Keep translation traffic on the private/local network between PiVoice, fffleet and the operator-PC worker.
- Do not expose the worker or fffleet control interface publicly.
- Do not introduce inbound Internet access to the Raspberry Pi.
- Do not send caption text to external translation services.
- Keep logs free of caption text and secrets.
- Bound queued work, batch sizes, retries, timeouts and worker memory use.
- Honour job cancellation and prevent abandoned jobs from continuing indefinitely.
- Preserve original captions if the worker, operator PC or fffleet is unavailable.
- Report translation lag and failures without blocking capture, transcription or publication.
- Define a policy for stale queued jobs so that old live captions are not published as current after a prolonged outage.

## Implementation phases

### Phase 0 — Inspect current contracts

- Inspect PiVoice's existing transcript event model and caption consumers.
- Identify where original caption tracks and segment identities are currently represented.
- Inspect the fffleet client API and the deployed fffleet version's custom-executor contract.
- Confirm worker registration, capability reporting, cancellation and inline-output behaviour.
- Confirm the operator PC operating system, CPU, RAM and available storage.
- Select candidate model/runtime combinations for a small proof of concept.

**Exit criteria:** documented PiVoice integration points, verified fffleet job contract and a model/runtime candidate that can be benchmarked on the operator PC.

### Phase 1 — Define PiVoice translation lifecycle

- Define the source-track and translated-track data model.
- Define translation status and error states.
- Define how source transcript revisions invalidate or update translations.
- Define bounded batching, job identity and retry behaviour.
- Define how translation status and completed tracks are exposed to existing consumers.

**Exit criteria:** documented lifecycle and API/event contract; original caption delivery remains independent.

### Phase 2 — Prove local translation inference

- Implement a minimal Node.js proof of concept on the operator PC.
- Install one compatible model for one direction.
- Verify offline operation after model installation.
- Measure model load time, memory use, translation latency and throughput.
- Verify output quality on representative Finnish, English and Swedish spoken-caption samples.
- Record model licence and provenance.

**Exit criteria:** one direction runs locally and reliably with measured resource use and an approved model licence.

### Phase 3 — Implement the fffleet translation executor

- Implement the `translate` custom executor.
- Implement local model discovery, readiness and direction capability reporting.
- Validate source/target language pairs and segment payloads.
- Return translations keyed by original segment IDs.
- Honour cancellation, timeouts and bounded resource use.
- Add tests for unavailable models, unsupported directions, malformed input and inference failures.

**Exit criteria:** fffleet can schedule a translation job to the operator-PC worker and receive validated inline text results.

### Phase 4 — Integrate translation orchestration into PiVoice

- Add translation-track lifecycle management to PiVoice.
- Submit bounded jobs through fffleet with the requested direction capability.
- Match results to source segment IDs and preserve timing/metadata in PiVoice.
- Implement retries and stale-source handling.
- Ensure translation failures never block original captions or unrelated consumers.

**Exit criteria:** an original caption stream can produce a separate translated track end to end, with correct segment alignment and observable status.

### Phase 5 — Expand language directions

- Add the remaining policy-allowed directions one by one.
- Install and test a compatible direct model for each direction.
- Advertise only directions that pass quality, compatibility and performance checks.
- Verify same-language requests are rejected or handled as explicit no-ops.
- Verify unsupported source languages are rejected.

**Exit criteria:** every advertised direction is backed by a tested model and worker capability; unavailable directions are clearly reported.

### Phase 6 — Operational verification

- Test operator-PC restart and worker reconnection.
- Test fffleet outage, queued work, cancellation and recovery.
- Test model load/unload behaviour under concurrent target-language demand.
- Test sustained live-caption translation and lag under realistic load.
- Test source transcript corrections and stale translation invalidation.
- Verify no caption content is sent to external services or exposed in logs.
- Document model installation, upgrade, rollback and capability verification.

**Exit criteria:** translation operates locally and predictably under normal load and expected failure conditions without disturbing the original caption lifecycle.

## Non-goals

- A separate PiTranslate HTTP service for caption lifecycle or request orchestration.
- Translation inference on the already-loaded Raspberry Pi as a fallback.
- External/cloud translation APIs.
- Translation of arbitrary source languages or automatic expansion of the source-language policy.
- Translation through an unadvertised intermediate language.
- Worker ownership of caption tracks, recordings, sessions, timing or publication.
- Replacing or modifying the existing speech-recognition system.

## References

- [fffleet](https://github.com/jsilvanus/fffleet)
- [fffleet custom job types](https://github.com/jsilvanus/fffleet/blob/main/docs/integration-guide.md#custom-job-types)
- [fffleet architecture](https://github.com/jsilvanus/fffleet/blob/main/docs/architecture.md)
- [PiVoice main plan](./../plan.md)
- [PiTranslate repository (earlier experiment)](https://github.com/jsilvanus/pitranslate)
