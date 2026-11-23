#!/usr/bin/env python3
"""Export a downloaded OPUS-MT (MarianMT) snapshot to the layout the marian-onnx engine reads.

Used by fetch-models.mjs for directions that have no published ONNX conversion. Needs
`pip install "optimum[onnxruntime]" optimum-onnx accelerate sentencepiece` (CPU torch is enough).

    python3 export_marian.py <snapshot dir> <output dir>

Output: config.json, generation_config.json, tokenizer.json, tokenizer_config.json,
onnx/encoder_model_quantized.onnx, onnx/decoder_model_merged_quantized.onnx (int8 dynamic).
Nothing here downloads; the snapshot is fetched (and pinned) by the caller.
"""
import base64
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

LOW_SCORE = -1.0e4  # target-only pieces: never chosen when encoding source text


def build_tokenizer_json(src: Path) -> dict:
    """tokenizer.json (Hugging Face tokenizers format) for Transformers.js's MarianTokenizer.

    Ids are vocab.json ids. Scores come from source.spm, so encoding picks the same pieces as
    the Python MarianTokenizer; pieces only the target side uses get a very low score.
    """
    from sentencepiece import sentencepiece_model_pb2 as pb

    model = pb.ModelProto()
    model.ParseFromString((src / "source.spm").read_bytes())
    scores = {p.piece: p.score for p in model.pieces}
    vocab = json.loads((src / "vocab.json").read_text(encoding="utf-8"))
    by_id = sorted(vocab.items(), key=lambda kv: kv[1])
    if [i for _, i in by_id] != list(range(len(by_id))):
        raise SystemExit("vocab.json ids are not contiguous")
    pieces = [[p, float(scores.get(p, LOW_SCORE))] for p, _ in by_id]
    special = ["</s>", "<unk>", "<pad>"]
    for s in special:
        if s not in vocab:
            raise SystemExit(f"vocab.json has no {s}")
    charsmap = model.normalizer_spec.precompiled_charsmap
    return {
        "version": "1.0",
        "truncation": None,
        "padding": None,
        "added_tokens": [
            {"id": vocab[s], "special": True, "content": s, "single_word": False,
             "lstrip": False, "rstrip": False, "normalized": False}
            for s in special
        ],
        "normalizer": {
            "type": "Precompiled",
            "precompiled_charsmap": base64.b64encode(charsmap).decode("ascii") if charsmap else None,
        },
        "pre_tokenizer": {"type": "Sequence", "pretokenizers": [
            {"type": "WhitespaceSplit"},
            {"type": "Metaspace", "replacement": "▁", "add_prefix_space": True},
        ]},
        "post_processor": {
            "type": "TemplateProcessing",
            "single": [{"Sequence": {"id": "A", "type_id": 0}}, {"SpecialToken": {"id": "</s>", "type_id": 0}}],
            "pair": [{"Sequence": {"id": "A", "type_id": 0}}, {"SpecialToken": {"id": "</s>", "type_id": 0}},
                     {"Sequence": {"id": "B", "type_id": 0}}, {"SpecialToken": {"id": "</s>", "type_id": 0}}],
            "special_tokens": {"</s>": {"id": "</s>", "ids": [vocab["</s>"]], "tokens": ["</s>"]}},
        },
        "decoder": {"type": "Metaspace", "replacement": "▁", "add_prefix_space": True},
        "model": {"type": "Unigram", "unk_id": vocab["<unk>"], "vocab": pieces},
    }


def quantize(src_onnx: Path, dst_onnx: Path) -> None:
    from onnxruntime.quantization import QuantType, quantize_dynamic

    # EnableSubgraph: the merged decoder keeps both branches inside an If node.
    quantize_dynamic(str(src_onnx), str(dst_onnx), weight_type=QuantType.QUInt8,
                     extra_options={"EnableSubgraph": True})


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    src, out = Path(argv[1]).resolve(), Path(argv[2]).resolve()
    (out / "onnx").mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="marian-export-") as tmp:
        subprocess.run(
            ["optimum-cli", "export", "onnx", "-m", str(src), "--task", "text2text-generation-with-past", tmp],
            check=True,
        )
        tmp = Path(tmp)
        quantize(tmp / "encoder_model.onnx", out / "onnx" / "encoder_model_quantized.onnx")
        quantize(tmp / "decoder_model_merged.onnx", out / "onnx" / "decoder_model_merged_quantized.onnx")
    for name in ("config.json", "generation_config.json", "tokenizer_config.json"):
        if (src / name).exists():
            shutil.copyfile(src / name, out / name)
    (out / "tokenizer.json").write_text(json.dumps(build_tokenizer_json(src), ensure_ascii=False), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
