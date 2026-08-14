"""Dump the reference pipeline's intermediate tensors for a fixed noise seed.

Comparing by ear has not localised why our chain sounds less natural than the
reference on identical weights. This pins the randomness so the two
implementations can be diffed numerically instead: whichever tensor first
diverges is where the bug lives.
"""

import json

import numpy as np
from supertonic import TTS

TEXT = "In the beginning God created the heaven and the earth."
OUT = "spikes/supertonic-chain/reference-dump.json"

tts = TTS()
model = tts.model
style = tts.get_voice_style("F1")

text_ids, text_mask = model.text_processor([TEXT], None)

dur, *_ = model.dp_ort.run(
    None, {"text_ids": text_ids, "style_dp": style.dp, "text_mask": text_mask}
)
speed = 1.05
dur_scaled = dur / speed

text_emb, *_ = model.text_enc_ort.run(
    None, {"text_ids": text_ids, "style_ttl": style.ttl, "text_mask": text_mask}
)

# Reproduce sample_noisy_latent exactly, but with a deterministic draw.
wav_len_max = dur_scaled.max() * model.sample_rate
chunk_size = model.base_chunk_size * model.chunk_compress_factor
latent_len = int((wav_len_max + chunk_size - 1) / chunk_size)
latent_dim = model.ldim * model.chunk_compress_factor

rng = np.random.default_rng(1234)
noise = rng.standard_normal((1, latent_dim, latent_len)).astype(np.float32)

latent_mask = np.ones((1, 1, latent_len), dtype=np.float32)
xt = noise * latent_mask

total_step = 8
total_step_np = np.array([total_step], dtype=np.float32)
for step in range(total_step):
    xt, *_ = model.vector_est_ort.run(
        None,
        {
            "noisy_latent": xt,
            "text_emb": text_emb,
            "style_ttl": style.ttl,
            "text_mask": text_mask,
            "latent_mask": latent_mask,
            "current_step": np.array([step], dtype=np.float32),
            "total_step": total_step_np,
        },
    )

wav, *_ = model.vocoder_ort.run(None, {"latent": xt})
wav = np.asarray(wav).reshape(-1)


def stats(name, arr):
    a = np.asarray(arr, dtype=np.float64).reshape(-1)
    return {
        "name": name,
        "shape": list(np.asarray(arr).shape),
        "mean": float(a.mean()),
        "std": float(a.std()),
        "min": float(a.min()),
        "max": float(a.max()),
        "first8": [float(x) for x in a[:8]],
    }


payload = {
    "text": TEXT,
    "speed": speed,
    "total_step": total_step,
    "duration_raw": float(dur.reshape(-1)[0]),
    "duration_scaled": float(dur_scaled.reshape(-1)[0]),
    "latent_len": latent_len,
    "latent_dim": latent_dim,
    "text_ids": [int(x) for x in np.asarray(text_ids).reshape(-1)],
    "text_mask_shape": list(np.asarray(text_mask).shape),
    "noise": [float(x) for x in noise.reshape(-1)],
    "tensors": [
        stats("text_emb", text_emb),
        stats("latent_final", xt),
        stats("wav", wav),
    ],
    "wav_len": int(wav.size),
    "wav_first32": [float(x) for x in wav[:32]],
}

with open(OUT, "w", encoding="utf-8") as f:
    json.dump(payload, f)

print(f"duration raw {payload['duration_raw']:.4f}s -> scaled {payload['duration_scaled']:.4f}s")
print(f"latent {latent_dim} x {latent_len}   wav {payload['wav_len']} samples ({payload['wav_len'] / 44100:.2f}s)")
for t in payload["tensors"]:
    print(f"  {t['name']:<14} shape={t['shape']} mean={t['mean']:+.5f} std={t['std']:.5f} min={t['min']:+.4f} max={t['max']:+.4f}")
print(f"wrote {OUT}")
