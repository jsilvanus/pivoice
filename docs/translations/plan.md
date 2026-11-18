# Caption translation plan

Status: plan for review, 2026-11-18. Nothing here is built. This version replaces the first draft of this file: it keeps its decisions (PiVoice owns the lifecycle, one fffleet job type `translate`, a narrow worker on the operator PC, no Pi fallback, a fixed language policy) and adds what the first draft left to "Phase 0": where transcripts actually flow today, the fffleet contract as it is in 2.8.0, the delivery path to the web relay and YouTube, latency, the model plan, configuration, API and phases with tests.

Legend: **[V]** verified in code (this repo or a sibling repo, read on 2026-11-18). **[U]** unverified, needs a test or a measurement. **[D]** a decision this plan proposes; change it if you disagree. **[J]** needs Juha.

---

## 1. Goal

Live captions in more languages than the one spoken, produced locally and delivered beside the original captions:

- The spoken language (Finnish, English or Swedish) is transcribed as today.
- PiVoice turns each final transcript into translations for the enabled target languages.
- The translation runs on one of three routes: an MT model on an fffleet worker on the operator PC, the ollama LLM on the operator PC, or a hosted API. Never a model on the Pi.
- Translations reach web listeners (web-radio-relay, which shows a language choice) and anyone else on the pigateway bus. YouTube keeps the original track (section 9.3).

Hard rules:

- Translation never blocks or delays the original captions, the radio, capture or transcription.
- No translation inference on the Pi, not even as a fallback.
- No caption text in logs, status, errors or job ids. No real transcripts, names or liturgy texts in this public repository; test data is invented.
- No model weights in any repository. Models are installed on the operator PC outside the source tree.
- Node 24, ESM, pnpm, OpenAPI first (`openapi/openapi.yaml`, CLI generated from it).

---

## 2. Where things are today [V]

### 2.1 Transcripts

PiVoice already sees every final transcript, in both auditor modes:

| Mode | Code | Event PiVoice emits |
|---|---|---|
| Upload (`/inference`) | `src/transcriber.js` | `{ seq, chunkSeq, startMs, endMs, text, language }`, `seq` is PiVoice's own counter |
| Pull (`/v1/live` + SSE) | `src/auditor-live.js` | same shape, `seq` = the auditor's `sequence` of the live session |

Both feed `PiVoiceService.#onTranscript` (`src/service.js`), which publishes a `transcript` event on PiVoice's own SSE bus and pushes to the two caption outputs PiVoice has itself: `RelayCaptions` (`src/captions/relay.js`, `POST /api/v1/streams/{s}/captions` on web-radio-relay, segments carry `lang`) and `YouTubeCaptions` (`src/captions/youtube.js`, `lcyt` sender, one track).

Transcripts are final. The auditor sends no interim or revised text (`pitube/CONTRACT.md` §2). `startMs`/`endMs` are epoch ms of the spoken audio, anchored at PiVoice.

### 2.2 The pigateway bus

In the deployed Pi stack pigateway is the transcript hub (`pigateway/src/transcripts/transcript-hub.ts`): the auditor delivers to it (`PIGATEWAY_TRANSCRIPT_DELIVERY=sse|push`; the gateway asks PiVoice to open the live session with that delivery), it numbers transcripts `<epoch>:<seq>`, de-duplicates on (session, engine sequence), keeps 500 for replay and serves them on `GET /api/v1/events` (`event: transcript`). pitube and web-radio-relay read that bus (`pitube/CONTRACT.md`). Which of the two caption paths (PiVoice direct push, or pigateway bus) is live on the church Pi today is **[U]**; this plan supports both.

### 2.3 fffleet 2.8.0

- Custom job types: a worker loads executors from `FFFLEET_EXECUTORS` into its own process and claims `type:<name>`. An executor is `{ type, run(spec, rt) }`; `rt.signal` carries cancel and timeout; small results travel inline (`outputs: [{ name, uri: 'inline:', data }]`).
- Because executors live in the worker process, a module-level model cache survives between jobs. That is what makes per-caption jobs affordable.
- Worker capabilities are the detected ones, `type:*`, `scheme:*`, probes and the static list in `FFFLEET_CAPABILITIES`. An executor cannot report capabilities itself.
- `workerPreference: [...]` orders eligible workers and is a strict allowlist. `fallback: 'none'` stops the client from running a job in-process when the fleet is down.
- Error codes the client sees: `TIMEOUT`, `CANCELLED`, `WORKER_LOST`, `ORCHESTRATOR_RESTARTED`, `QUEUE_FULL`, `INVALID_SPEC`, and others (`docs/integration-guide.md`).

### 2.4 Machines

- Pi: fffleet orchestrator on :5000 (user unit), already routes `perception-detect` to `operator-pc-detect` through a placement rule in its own `fffleet.yaml`.
- Operator PC: i5-10300H, 8 GB RAM (the limit), GTX 1650 Ti 4 GB. Already running auditor STT (GPU), ollama (qwen2.5:3b, gemma3:1b, bge-m3) and the CPU detect worker (`operator-pc-detect`, 600 MB cap). It is off when nobody is at church.

### 2.5 Neighbours that already plan translations

- **web-radio-relay PR #13** (`docs/media-relay-plan.md` §7, phase 8, decision 3): proposes that the relay itself calls a translation endpoint (`TRANSLATE_URL`) for each caption and stores answers as `translation` timeline events. It leaves the provider open (operator-PC LLM through the fleet, or hosted). Section 10 of this plan proposes the relay **consumes** translations instead of producing them.
- **LCYT** has its own translation (vendors MyMemory, Google, DeepL, LibreTranslate; `translation_targets`, `showOriginal` composition for YouTube). It is the reference for composition on a single YouTube track; this plan does not depend on it.

---

## 3. Architecture

Three routes, chosen by PiVoice per direction (Juha, 2026-11-18; section 5.6):

```
liturgos-auditor ──final transcripts──► PiVoice ──────────────► original captions (unchanged)
                                           │
                                           │ TranslationManager (new, src/translation/)
                                           │   translation memory hit ──► result now
                                           │   miss ──► route chain for <src>-<tgt>
                                           │
           ┌───────────────────────────────┼───────────────────────────────┐
           │ route "mt"                    │ route "llm"                   │ route "hosted"
           ▼                               ▼                               ▼
 fffleet orchestrator (Pi :5000)   ollama on the operator PC       hosted MT API (DeepL [D])
   requires translate:<src>-<tgt>    HTTP /api/chat, LAN only        HTTPS, outbound from the Pi
   workerPreference                  called directly by PiVoice      called directly by PiVoice
     [operator-pc-translate]
           ▼
 operator-pc-translate worker
   executor fleet/translate/executor.js
   engine marian-onnx (OPUS-MT, CPU)
           │ inline result                 │                               │
           └───────────────────────────────┴───────────────────────────────┘
                                           ▼
                                        PiVoice
                     ├─► PiVoice SSE  event: translation
                     ├─► web-radio-relay  segments with lang=<tgt>  (direct push path)
                     └─► pigateway  POST /api/v1/translations ─► bus event: translation
                                                         ├─► web-radio-relay (SSE pull path)
                                                         └─► pitube (ignored by default)
```

Responsibilities:

- **PiVoice:** language policy, which targets are on, route choice and fallback, batching, calling the routes, matching results to source segments, deadlines, retries, publication, status. The Pi never runs a model itself; the llm and hosted routes are HTTP calls.
- **fffleet (mt route only):** queue, placement on a worker that has the direction, cancel and timeout.
- **Worker executor (mt route only):** translate the given segments for one direction with a locally installed MT model. No sessions, tracks, retries or publication. Keeps nothing after the job.
- **ollama (llm route):** the existing ollama on the operator PC; PiVoice sends a prompt per batch. No new service.
- **Hosted API (hosted route):** an external MT service PiVoice calls with its own key.
- **pigateway:** carries translations on its bus like transcripts (section 10.1). It does not translate.

---

## 4. Language policy [D, kept from the first draft]

Sources: `fi`, `en`, `sv` only. Targets: `fi`, `en`, `sv`, `ru`, `uk`, `es`. No same-language direction, no pivot through a third language, no auto-detection.

| Source | Allowed targets |
|---|---|
| `fi` | `en`, `sv`, `ru`, `uk`, `es` |
| `en` | `fi`, `sv`, `ru`, `uk`, `es` |
| `sv` | `fi`, `en`, `ru`, `uk`, `es` |

The source language is the transcript's `language` (from the auditor, default PiVoice `auditor.language`). A transcript whose language is outside the source list is not translated and is counted (`skipped.unsupportedSource`). A configured target equal to the source is skipped silently for that segment (a Swedish reading in a Finnish service with targets `sv,en` yields only `en` for that segment).

Spanish stays in the policy but is left out of the first rollout (Juha, 2026-11-18): phases 1 to 7 build and evaluate `fi`/`en`/`sv`/`ru`/`uk` only; `es` directions are added later with the same checks.

Policy-allowed is not available. A direction is **available** when the fleet reports a worker with capability `translate:<src>-<tgt>` (section 7.2).

The policy lives in one module (`src/translation/policy.js`) with tests, so widening it later is one reviewed change.

---

## 5. PiVoice: TranslationManager

New directory `src/translation/`:

| File | Content |
|---|---|
| `policy.js` | language lists, `directionAllowed(src, tgt)`, capability name |
| `memory.js` | translation memory: exact match after normalisation (section 5.4) |
| `batcher.js` | per-target micro-batches |
| `routes/mt.js` | route over the `fffleet` client: submit, await, cancel, capabilities poll |
| `routes/llm.js` | route to ollama `/api/chat`: prompt, glossary, context, JSON answer parsing |
| `routes/hosted.js` | route to the hosted API (DeepL adapter first), key from env, character budget |
| `router.js` | per-direction route chain, availability, fallback (section 5.6) |
| `manager.js` | `TranslationManager` (EventEmitter): wires the above, deadlines, stats |
| `result.js` | validation of the worker answer |

### 5.1 Segment identity

Each source segment gets a key PiVoice and pigateway can both compute without talking to each other:

```
sourceKey = `${session}:${sequence}`
```

- Pull mode: `session` = auditor live session id, `sequence` = auditor `sequence` (the same pair pigateway de-duplicates on) [V for the pair, D for the key].
- Upload mode: `session` = `pivoice-<random per capture start>`, `sequence` = PiVoice `seq`.

The job sends segments with ids `0..n-1` (local to the job); PiVoice maps them back. Nothing from the session goes into the job payload.

### 5.2 Flow per transcript

1. `#onTranscript(event)` hands the event to the manager after the existing outputs (one call, wrapped in try/catch so a manager bug cannot reach the caption path).
2. Manager drops it if translation is off, the source language is unsupported, or no target is enabled.
3. For each enabled target `t != source`: memory lookup. Hit: emit the translation now. Miss: add to the batcher of `source-t`.
4. A batcher flushes after `batch.windowMs` (default 300 ms), or at `batch.maxSegments` (8) or `batch.maxChars` (2000).
5. Flush hands the batch to the first available route of the direction's chain (section 5.6); if none is available it counts `skipped.unavailable` and drops.
6. At most `maxInFlightPerTarget` jobs (default 2) per target; when full, segments wait in the batcher; the batcher is bounded (`maxQueuedPerTarget` 50, oldest dropped).
7. Result: validate (section 6.3), emit one `translation` per segment, publish (section 9).

### 5.3 Deadlines and staleness

A translation is useful only until its caption has been shown. Each segment carries `deadline = endMs + maxAgeMs` (default 60 s, the same rule as `RelayCaptions` and pitube). Before submit, at result time and before each publish, anything past its deadline is dropped and counted. Jobs get `timeoutMs` (default 10 s). A job still `queued` after `queueTimeoutMs` (default 3 s) is cancelled: an operator PC that is off must not collect a queue of old captions that all arrive later.

Retries: one retry for `WORKER_LOST`, `ORCHESTRATOR_RESTARTED` and `TIMEOUT`, only if the deadline still allows; none for `INVALID_SPEC` or a validation failure.

Since transcripts are final (section 2.1) there is no revision handling in the live path. The first draft's stale-revision machinery is left out [D]; if an editable transcript ever appears (for example in Saarnavideo post-production), it reuses the same job type with its own lifecycle there.

### 5.4 Translation memory [D]

Large parts of a service are fixed liturgy that the auditor transcribes nearly the same every Sunday ("Herra olkoon teidän kanssanne."). Official translations exist for many of them, and a model will translate them worse.

- A JSON file at `translation.memoryPath` (outside the repo; on the Pi beside `pivoice.env`; its source copy in the private keskuskirkko repository): `[{ src: "fi", text: "...", tr: { sv: "...", en: "..." } }]`.
- Lookup is exact after normalisation (case, whitespace, punctuation, Finnish/Swedish letters kept). No fuzzy matching in the first version: a near match that is wrong is worse than a model translation.
- A hit costs no job, adds no latency and is marked `origin: "memory"`.
- Reloaded on `SIGHUP` and on `PUT /api/v1/translation` with `reloadMemory: true`.
- Who may put which texts in it (copyright of official translations) is the operator's call; this repo ships only an invented example.

### 5.6 Routes and fallback [D]

All three routes are allowed (Juha, 2026-11-18). Each implements `translate(batch, { source, target, context, signal }) → [{ id, text }]` plus `available(direction)`, and returns `{ route, model }` for status and the event.

| Route | Path | Availability check | Strength | Cost |
|---|---|---|---|---|
| `mt` | fffleet job to `operator-pc-translate` (sections 6, 7) | fleet capability `translate:<src>-<tgt>`, polled every 30 s | local, small, fast on CPU | operator PC must be on |
| `llm` | PiVoice → ollama on the operator PC, `POST /api/chat` | `GET /api/tags` lists the configured model, polled every 30 s | uses context and a glossary; can handle a direction with no MT model | GPU shared with STT; small models are weak in Finnish |
| `hosted` | PiVoice → hosted API over HTTPS | key set, last call not refused for quota/auth, character budget left | best quality, works when the operator PC is off | text leaves the church, paid per character |

Per direction a **chain** in config, tried in order; the first available route takes the batch, and a route that fails (timeout, error, invalid result) hands the same batch to the next one if the deadline still allows:

```yaml
routes:
  default: [mt, hosted]
  fi-uk: [mt, llm, hosted]
```

- `memory` is always first and is not part of the chain.
- A route can be left out of every chain to switch it off. With no `hosted` key or `hosted.enabled: false`, the hosted route is never available, so nothing leaves the church by accident.
- Default chain `[mt, hosted]` [D]: local first, hosted when the operator PC is off or the worker fails. The `llm` route is opt-in per direction until its quality is measured (section 7.5).
- One route per batch: no mixing of routes inside one batch, so the event's `route`/`model` is exact.

**llm route details.** ollama listens on localhost on the operator PC today; this route needs it reachable from the Pi only (bind to the LAN address, Windows firewall rule allowing the Pi alone; ollama has no authentication) **[U, deploy step]**. Model from config (`llm.model`, start with the one already pulled; a better multilingual model only if RAM allows). Prompt: system text with the direction, register (church service, spoken), the glossary from the memory file, up to 2 previous source segments as context, and the batch as numbered lines; answer requested as JSON `{"translations":[{"id":0,"text":"..."}]}` with ollama's `format: "json"`, then the same validation as section 6.3. `keep_alive` short, so the model does not hold VRAM STT needs. Concurrency 1. Timeout 8 s.

**hosted route details.** First adapter DeepL API (it covers fi, en, sv, ru, uk, es) [D]; the interface leaves room for another provider. Key in `PIVOICE_TRANSLATE_HOSTED_KEY` only. One request per batch (`text[]`), `source_lang` set explicitly (no auto-detection), optional DeepL glossary built from the memory file. A monthly character budget in config (`hosted.monthlyCharBudget`); at the budget the route reports unavailable. Timeout 5 s, one retry on 429/5xx with back-off within the deadline. The Pi's egress allowlist gains the API host (main plan, "PiVoice egress allowlist").

### 5.7 Translation event

What PiVoice emits on its bus and publishes:

```json
{
  "sourceKey": "live_9f2c:42",
  "sourceSeq": 42,
  "session": "live_9f2c",
  "source": "fi",
  "lang": "en",
  "text": "The Lord be with you.",
  "startMs": 1761666000123,
  "endMs": 1761666002456,
  "origin": "model",
  "route": "mt",
  "model": "opus-mt-fi-en@<revision>",
  "latencyMs": 640
}
```

`origin` is `memory` or `model`; `route` is `mt`, `llm` or `hosted` (absent for memory). Times are the source segment's audio times, never the time of translation. `text` is capped at 500 characters like transcripts.

---

## 6. The `translate` job contract

### 6.1 Submission [D]

```js
await fleet.submit({
  id: `pivoice-tr-${runId}-${counter}`,     // no text, no session id
  kind: 'batch',
  type: 'translate',
  requires: ['translate:fi-en'],
  workerPreference: ['operator-pc-translate'],
  timeoutMs: 10_000,
  translate: {
    v: 1,
    source: 'fi',
    target: 'en',
    segments: [
      { id: 0, text: 'Tervetuloa jumalanpalvelukseen.' },
      { id: 1, text: 'Aloitamme yhteisellä virrellä.' }
    ],
  }
});
```

Client options: `fallback: 'none'`, own client id and secret with scope `jobs` (`FFFLEET_CLIENT_ID`/`FFFLEET_CLIENT_SECRET`), `FFFLEET_URL` = the Pi orchestrator.

Limits checked on both sides: 1 to 16 segments, each 1 to 500 characters, 4000 characters per job. Context is used only by the llm route, which does not go through the fleet.

### 6.2 Result

```js
{ exitCode: 0, outputs: [{ name: 'translations', uri: 'inline:', bytes, data: {
  v: 1,
  model: 'opus-mt-fi-en@<revision>',
  engine: 'marian-onnx',
  translations: [ { id: 0, text: 'Welcome to the service.' }, { id: 1, text: 'We begin with a hymn.' } ]
} }], stderrTail: null }
```

Executor errors are thrown as `Error` with a `code`: `UNSUPPORTED_DIRECTION`, `MODEL_UNAVAILABLE`, `INVALID_INPUT`, `INFERENCE_FAILED`. The message never contains segment text.

### 6.3 Validation in PiVoice

Every input id exactly once, no unknown ids, text non-empty after trim, at most 500 characters (cut, counted), not identical to a different segment's source (a common failure where a model echoes). A failed validation drops the whole job's result and counts `failed.invalidResult`.

### 6.4 Latency [U]

Per job: orchestrator placement + dispatch to the worker + inference + result back to the client. The fleet part has not been measured for tiny jobs; it is phase 1's first measurement. Target: p95 under 1.5 s from transcript to translation for a 1-segment job with a warm model. If the fleet round trip alone is above about 700 ms, the fallback design is one `kind: 'stream'` job per direction that reads NDJSON on stdin and writes NDJSON on stdout; whether fffleet's `stdin`/`stdout` piping reaches custom executors (it is documented for ffmpeg) is **[U]** and would be a small generic fffleet change if it does not.

---

## 7. Worker on the operator PC

### 7.1 Code and image [D]

- Code in this repository under `fleet/translate/` (its own `package.json`, pnpm workspace member), so the Pi install of PiVoice does not pull model runtimes. This follows Saarnavideo's `fleet/download-executor.mjs` and piperception's detect worker: the generic fffleet repo never mentions the app.
- Image `ghcr.io/jsilvanus/pivoice-translate-worker`: published `fffleet-worker` 2.8.x base + `fleet/translate` + runtime deps. No weights in the image.
- Compose service `translate-worker` in the operator-PC stack (piecosystem), worker id `operator-pc-translate`, models mounted read-only from a host directory, memory cap 2 GB to start (section 7.4), `kinds: batch`, slots 2.
- Pi `fffleet.yaml` placement rule: type `translate` → `[operator-pc-translate]`, like `perception-detect`.

### 7.2 Capabilities

The worker cannot report capabilities from an executor (section 2.3), so the container entrypoint does it:

1. Read `models.json` from the model directory: `{ "fi-en": { engine: "marian-onnx", path: "opus-mt-fi-en", revision, licence }, ... }`.
2. For each entry: load, translate one fixed invented sentence, check the output is non-empty and not the input, unload.
3. Start `fffleet-worker` with `FFFLEET_CAPABILITIES=translate:fi-en,translate:fi-sv,...` for the entries that passed.

A model change needs a container restart; acceptable for something changed a few times a year. A generic fffleet feature "executor reports capabilities" would remove the restart; it is not needed now.

### 7.3 Executor

- Validates the payload (`v`, policy, limits) and that the direction is in its loaded manifest.
- Model cache: LRU of loaded directions, bounded by `TRANSLATE_MAX_LOADED` (default 3) and an estimated memory budget from the manifest. A cold load is part of the job and is reported with `rt.setState('loading-model')`.
- Inference serialised per model (one at a time per direction); `rt.signal` aborts between segments.
- `TRANSLATE_THREADS` (default 2) for ONNX Runtime, so detection and STT keep CPU.
- Logs: direction, segment count, character count, timings. Never text.

### 7.4 Engines and models

The worker serves only the mt route. Engine: `marian-onnx`, `@huggingface/transformers` (ONNX Runtime, CPU), MarianMT, int8 quantised. The LLM and the hosted API are not in the worker: PiVoice calls them directly (section 5.6), so the worker has one job and no keys.

Candidate models: Helsinki-NLP OPUS-MT (Marian), CC-BY 4.0, per direction about 300 MB fp32 on disk, less after int8. Direct models are believed to exist for most of the 15 directions (`fi-en`, `en-fi`, `fi-sv`, `sv-fi`, `en-sv`, `sv-en`, `en-ru`, `en-uk`, `en-es`, `fi-ru`, `fi-uk`, `fi-es`, `sv-ru`, `sv-uk`, `sv-es`), some also as `tc-big` variants. Every one is **[U]**: existence, ONNX export, quality. A direction without a usable direct model is simply not advertised (no pivot). Argos/LibreTranslate is ruled out because it pivots through English. NLLB-200 is ruled out by its non-commercial licence unless Juha accepts it.

Memory: expected a few hundred MB per loaded int8 model **[U]**; with `TRANSLATE_MAX_LOADED=3` the container should fit in 2 GB. The 8 GB operator PC is already the limit, so phase 1 measures peak RSS beside a running auditor, ollama and detect worker before the cap is fixed. The GPU is not used: it is shared by STT and ollama, the same reason the detect worker runs on CPU.

Models are fetched once by a setup script (`fleet/translate/scripts/fetch-models.mjs`: download, export or use a published ONNX conversion, quantise, write `models.json` with revision and licence), never during a service. Attribution for CC-BY models goes in the worker README and the status output.

### 7.5 Quality checks

- Invented test sentences in the repo (liturgical register, numbers, Bible references, names of invented people) for unit and smoke tests.
- A private evaluation set (real service transcripts, outside the repo) scored with chrF per direction, plus a short human read by a speaker of each target language. Juha has a reader for Russian and Ukrainian; Spanish is not in the first rollout. A direction is enabled for a real service only after that read.
- The memory (section 5.4) is the first quality tool: fixed texts never go through a model.

---

## 8. Configuration and API

### 8.1 Config (zod, `src/config.js`) [D]

```yaml
translation:
  mode: off            # off | on | auto (auto = while any caption output is running)
  targets: [en]        # subset of the policy targets
  memoryPath: null
  routes:
    default: [mt, hosted]
    # fi-uk: [mt, llm, hosted]
  fleet:               # mt route
    url: null          # PIVOICE_FFFLEET_URL, e.g. http://127.0.0.1:5000
    workerPreference: [operator-pc-translate]
  llm:                 # llm route
    url: null          # ollama base URL on the operator PC
    model: qwen2.5:3b
    timeoutMs: 8000
    keepAlive: 30s
  hosted:              # hosted route
    enabled: false
    provider: deepl
    url: https://api.deepl.com    # api-free.deepl.com for a free key
    timeoutMs: 5000
    monthlyCharBudget: 500000
  batch: { windowMs: 300, maxSegments: 8, maxChars: 2000 }
  maxInFlightPerTarget: 2
  maxQueuedPerTarget: 50
  jobTimeoutMs: 10000
  queueTimeoutMs: 3000
  maxAgeMs: 60000
  publish:
    events: true       # PiVoice SSE
    relay: true        # direct push to web-radio-relay when captions.relay is on
    gateway: false     # POST to pigateway (section 10.1)
```

Secrets only from the environment: `FFFLEET_CLIENT_ID`, `FFFLEET_CLIENT_SECRET` (or `FFFLEET_TOKEN`), `PIVOICE_TRANSLATE_HOSTED_KEY`, `PIVOICE_GATEWAY_API_TOKEN`.

### 8.2 API (OpenAPI, CLI regenerated)

- `GET /api/v1/translation`: mode, targets, per route `{ available, lastError }` (hosted also `charsThisMonth`), per target `{ available, route, model, sent, fromMemory, failed, dropped: {late, unavailable, queueFull}, latencyMs: {p50, p95}, lastError }`, worker attribution text. Never text.
- `PUT /api/v1/translation`: `{ mode?, targets?, routes?, hostedEnabled?, reloadMemory? }`, validated against the policy. Switching hosted on or off is a live operator choice.
- `GET /api/v1/translation/languages`: the policy table plus which directions are available now.
- `GET /api/v1/transcription/events` (existing SSE) gains `event: translation`.

Availability comes from each route's check (section 5.6), polled every 30 s and after every failure. The same data goes to picontrol through pigateway's existing PiVoice status proxy.

### 8.3 Telemetry

The UDP telemetry packet does not change. Translation status travels only in the HTTP status.

---

## 9. Delivery

### 9.1 PiVoice's own outputs

- `RelayCaptions.push` already takes `language`; translations are pushed as ordinary segments with `lang = target`. Whether the relay accepts several languages for overlapping times in one stream is **[U]** against web-radio-relay `captions.js`.
- `YouTubeCaptions` is not given translations (section 9.3).

### 9.2 The pigateway bus

See section 10.1. With `publish.gateway: true` PiVoice posts each translation; pigateway puts it on the bus.

### 9.3 YouTube [D]

YouTube's HTTP caption ingestion carries one track. Options are original only, one translation instead of the original, or a composed caption (original line + translation line, as LCYT's `showOriginal`). Default: **original only**. A later pitube option `youtubeCaptionLanguage` with composition can be added; it needs a pitube contract change and a wait-for-translation rule, so it is out of the first phases.

---

## 10. Changes in other repositories (planned here, built in their own threads)

### 10.1 pigateway [D]

- `POST /api/v1/translations` (Bearer, LAN): body `{ events: [translation events, 1..100] }`.
- A `TranslationHub` beside `TranscriptHub`: validates, resolves `sourceId` (`<epoch>:<seq>` of the transcript with the same (session, sequence), if still in the ring), numbers, keeps a bounded ring for replay, de-duplicates on `(sourceKey, lang)`.
- Bus event `translation`, id `<epoch>:t<seq>`, data = the event of section 5.7 plus `epoch`, `seq`, `sourceId`. `?types=` filtering works unchanged.
- `pitube/CONTRACT.md` §1 gets the row; pitube ignores it.

### 10.2 web-radio-relay (align with PR #13) [D, needs the relay thread to agree]

Proposed change to `docs/media-relay-plan.md`:

- §7 Translations: the relay does not call a translation service. It takes `translation` events from the pigateway SSE pull (`types=transcript,translation,...`) and from PiVoice's direct push, and stores them as `translation` timeline events (`text`, `lang`, `sourceId`).
- Phase 8 becomes "translation ingest, per-stream visible languages, late flagging" instead of "translator adapter"; `TRANSLATE_URL` is dropped.
- Decision 3 (provider) is answered by this plan's decision 1.
- The listener delay must cover STT latency + translation latency (p95 from section 6.4). Late translations stay shown and flagged, as the relay plan already says.

### 10.3 piecosystem

`translate-worker` compose service for the operator PC, placement rule in the Pi orchestrator's `fffleet.yaml`, env template entries. The Pi's own copy of `fffleet.yaml` differs from piecosystem's; deploy edits it in place as for perception.

### 10.4 fffleet

No change needed for the batch design. Possible later, generic: executor-reported capabilities (section 7.2); stdin/stdout for custom executors (section 6.4) if the measurement asks for the stream design.

---

## 11. Security and privacy

- mt and llm routes stay on the church LAN: PiVoice → orchestrator → worker, and PiVoice → ollama. No inbound internet route.
- The hosted route sends caption text out of the church (Juha allowed it, 2026-11-18). It is off until `hosted.enabled` and a key are set, outbound HTTPS only, provider and data-processing terms recorded in the parish's processing records (speech in a service can contain names and personal matters). Prefer a provider plan whose terms say texts are not stored or used for training (DeepL API Pro says so; the free API does not promise it) **[U: confirm terms at setup]**.
- ollama has no authentication: reachable from the Pi only, by firewall.
- PiVoice has its own fffleet client with scope `jobs` only.
- The worker port is LAN-only with a worker token, like the detect worker.
- Caption text exists only in job payloads, in memory, and is not logged by PiVoice, the orchestrator (check its job logging, **[U]**) or the executor. Job ids carry no text or session ids. Finished job records in the orchestrator keep the inline result for a while; check the retention and make it short for `type: translate` **[U]**.

---

## 12. Phases (each a PR, tested, deployable alone)

| # | Repo | Content | Exit |
|---|---|---|---|
| 0 | pivoice | This plan | merged |
| 1 | pivoice | `fleet/translate` executor + `marian-onnx` engine + entrypoint capability scan + fetch script; tests with a fake engine | one direction (`fi-en`) runs in a local fffleet worker; latency, RSS and load time measured on a dev machine |
| 2 | piecosystem | `translate-worker` image build and compose service, Pi placement rule | `operator-pc-translate` registers with `translate:fi-en`; measured beside STT + ollama + detect |
| 3 | pivoice | `src/translation/` manager, policy, batcher, memory, router, mt route, config, API, SSE event, relay push | live transcript → translated segment on PiVoice SSE and on the relay, end to end on the church LAN |
| 3b | pivoice | hosted route (DeepL adapter, budget) and llm route (ollama), route chains and fallback | operator PC off → hosted takes over within one batch; llm route usable per direction |
| 4 | pigateway | `POST /api/v1/translations`, `TranslationHub`, bus event; pitube contract row | translations on the bus with replay |
| 5 | web-radio-relay | translation ingest (relay plan phase 8, changed per 10.2) | listener page shows a language choice |
| 6 | operator PC | remaining directions one by one (no `es` yet), private evaluation, human reads for ru/uk | every advertised direction passed its checks |
| 7 | all | operations: PC off/on during a service, fleet restart, queue timeout, 90 min soak | translation degrades to "unavailable" and recovers without touching original captions |

Phases 1 and 2 decide whether the batch design holds (section 6.4). Phase 3b needs no worker and can start in parallel with 1; with only the hosted route it already gives a working translation path. Phase 4 can run in parallel with 3. Phase 6 also compares mt, llm and hosted per direction on the private evaluation set and sets each direction's chain from that.

### Tests

- Unit (`node --test`): policy table; normalisation and memory lookup; batcher windows and limits; deadline drops; retry rules; result validation (missing, duplicate, unknown ids, echoes); config validation; OpenAPI and CLI generation check.
- Executor: fake engine (no model) for payload validation, cancel via `rt.signal`, error codes, no text in errors or logs (a test greps captured log output for the input sentences).
- Integration: in-process fffleet orchestrator + worker on port 0 (fffleet's test pattern) with the fake engine: placement by `translate:` capability, `workerPreference` allowlist, `fallback: 'none'` with no worker, queue timeout cancel.
- Real model: one optional test, skipped unless `PIVOICE_TRANSLATE_MODEL_DIR` is set; never in CI.
- Never against the real church stream, real YouTube or real transcripts.

---

## 13. Risks

| Risk | Check | Fallback |
|---|---|---|
| Fleet round trip too slow for live captions | phase 1 measurement | stream job per direction (section 6.4) |
| Operator PC out of RAM with STT + ollama + detect + translate | phase 2 measurement | fewer loaded models, smaller cap, unload ollama models when idle |
| OPUS-MT quality poor on spoken, unpunctuated Finnish | private evaluation | memory for fixed texts; put llm or hosted first in that direction's chain |
| Hosted bill or quota | character budget, status | route becomes unavailable at the budget; chain falls to the next route |
| LLM route steals VRAM from STT | measure with STT running | short `keep_alive`, small model, or leave llm out of the chains |
| Missing direct model for a direction | phase 6 | direction not offered |
| Auditor segments cut mid-sentence, translations of fragments read badly | evaluation | batch window joins neighbouring fragments of one sentence before translating (later, needs sentence-end detection) |
| Translations arrive after the listener delay | relay late flag, PiVoice p95 | raise relay delay for streams with translation |
| PC off during a service | status shows unavailable | original captions continue; nothing queues |

---

## 14. Not in scope

Translation on the Pi; pivot translation; source languages beyond fi/en/sv; language auto-detection; translating hymn lyrics or graphics; several translated tracks on YouTube; editing or correcting translations by hand during a service; a separate PiTranslate service (the pitranslate repository stays an experiment); Saarnavideo post-production translation (it can reuse the `translate` job type later).

---

## 15. Decisions for Juha

1. ~~Translation engine~~ Settled 2026-11-18: all three allowed, as separate routes: MT models through the fleet worker, ollama called directly, hosted API called directly from PiVoice (section 5.6). This also answers web-radio-relay decision 3.
2. ~~Reviewers~~ Settled 2026-11-18: Juha has a reader for Russian and Ukrainian; Spanish is left out of the first rollout.

Everything else above is a [D] default the implementing threads may follow.

## References

- [fffleet integration guide, custom job types](https://github.com/jsilvanus/fffleet/blob/main/docs/integration-guide.md#custom-job-types)
- [fffleet architecture, placement](https://github.com/jsilvanus/fffleet/blob/main/docs/architecture.md)
- [pitube contract](https://github.com/jsilvanus/pitube/blob/main/CONTRACT.md)
- web-radio-relay PR #13, `docs/media-relay-plan.md` §7 and §16
- [PiVoice main plan](../plan.md)
