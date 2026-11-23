# PiVoice translate worker

An fffleet worker that claims job type `translate` and translates caption segments with OPUS-MT
(MarianMT) models on the CPU. It runs on the operator PC (`operator-pc-translate`), never on the Pi.
Plan: [`docs/translations/plan.md`](../../docs/translations/plan.md) section 7.

- `executor.js`: the job (`spec.translate = { v: 1, source, target, segments }`), payload limits, LRU of
  loaded models (`TRANSLATE_MAX_LOADED`, default 3), one inference at a time per model. Logs counts and
  timings, never text.
- `engines/marian-onnx.js`: Transformers.js (`@huggingface/transformers` 3.x) on ONNX Runtime, int8
  (`q8`) weights, `TRANSLATE_THREADS` (default 2) intra-op threads. Remote loading is off: a missing file
  fails, nothing is downloaded at run time.
- `entrypoint.mjs`: the container entrypoint. Loads every model in `models.json` once, translates an
  invented sentence and starts `fffleet-worker` with `translate:<src>-<tgt>` added to
  `FFFLEET_CAPABILITIES` for each model that passed. A new model needs a container restart.
- `scripts/fetch-models.mjs`: fetches models into the model directory (below).
- Image: `ghcr.io/jsilvanus/pivoice-translate-worker` from [`docker/translate-worker.Dockerfile`](../../docker/translate-worker.Dockerfile),
  pushed by CI on main. Compose service `translate-worker` in piecosystem `deploy/operator-pc`.

## Models

No weights in this repository or in the image. The model directory (`TRANSLATE_MODEL_DIR`, `/models` in
the image) holds one folder per direction and `models.json`:

```json
{ "fi-en": { "engine": "marian-onnx", "path": "opus-mt-fi-en", "revision": "a623e4812687", "commit": "a623e48…",
             "source": "Xenova/opus-mt-fi-en", "upstream": "Helsinki-NLP/opus-mt-fi-en",
             "method": "published-onnx", "licence": "Apache-2.0", "attribution": "…", "fetchedAt": "…" } }
```

Fetch them once, by hand:

```sh
node scripts/fetch-models.mjs --dir /path/to/models --directions fi-en,fi-sv
# on the operator PC (piecosystem deploy/operator-pc):
docker compose --profile tools run --rm translate-models --directions fi-en
docker compose restart translate-worker
```

Per direction the script takes a published Transformers.js ONNX conversion (`Xenova/opus-mt-<src>-<tgt>`)
when it exists, otherwise the original `Helsinki-NLP/opus-mt-<src>-<tgt>` checkpoint, which it exports and
quantises. Every file is pinned to one commit and checked against the hub's size and sha256; a direction
is moved into place only when complete; other entries of `models.json` are kept. `--revision fi-en=<commit>`
pins a commit, `--force` refetches. Directions outside the language policy are refused.

What exists on the hub (checked 2026-11-23):

| Directions | Source |
|---|---|
| fi-en, en-fi, en-sv, sv-en, en-ru, en-uk, en-es | published ONNX (`Xenova/…`), no Python needed |
| fi-sv, sv-fi, fi-ru, fi-uk, fi-es, sv-ru, sv-uk, sv-es | `Helsinki-NLP/…` checkpoint only: export |

Larger `opus-mt-tc-big-*` models exist for fi-en, en-fi and en-es; not used yet.

### Exporting a model

`scripts/export_marian.py` (called by the fetch script) needs Python 3.10+ with:

```sh
pip install --index-url https://download.pytorch.org/whl/cpu torch
pip install "optimum[onnxruntime]" optimum-onnx accelerate sentencepiece
```

It runs `optimum-cli export onnx --task text2text-generation-with-past`, quantises the encoder and the
merged decoder to int8 (dynamic, `EnableSubgraph` so the merged decoder's branches are quantised too, about
50 + 57 MB), and writes a `tokenizer.json` for Transformers.js from `vocab.json` and `source.spm`. That
tokenizer gives the same input ids as the Python `MarianTokenizer` (checked on fi-en). The worker image has
no Python; run the export on a machine that has it and copy the folder and its `models.json` entry, or use
`--python` to point at a virtualenv.

### Licences and attribution

OPUS-MT models are by the Language Technology Research Group at the University of Helsinki
(Tiedemann and Thottingal, "OPUS-MT: Building open translation services for the World", EAMT 2020).
The models used so far are Apache-2.0; some newer ones are CC-BY-4.0. The fetch script records the
upstream licence and an attribution line per model in `models.json`. Model licences differ from this
repository's licence.

## Measured (cloud container, 4 vCPU, 2 threads; 2026-11-23)

Not the operator PC; T21 repeats these there.

- fi-en int8, one sentence: 150 to 400 ms (warm). Load: 0.6 to 1 s. RSS about 300 MB per loaded model
  (500 MB process with one model, 900 MB with two).
- Through the fleet (orchestrator + worker container + PiVoice's mt route, one-segment jobs): p50 212 ms,
  p95 376 ms over 24 jobs; first job after start 1.1 s (model load). Fleet overhead about 30 to 50 ms, so
  the batch design holds (plan §6.4) and no stream job is needed.
- Batching several sentences into one `translator([...])` call is about twice as fast but adds stray
  punctuation (`everyone..`) from padding, so the engine translates one sentence at a time.
