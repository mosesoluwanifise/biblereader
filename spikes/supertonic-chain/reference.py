"""Known-good baseline from the official implementation.

Our chain produces intelligible but unnatural speech. This renders the same
sentence through Supertone's own pipeline so the two can be compared by ear —
if the reference sounds equally unnatural, that is the model at these settings
and not a defect in our chain.

Two reference defaults we do not apply are worth noticing: speed=1.05 and
silence_duration=0.3.
"""

import time

from supertonic import TTS

TEXT = "In the beginning God created the heaven and the earth."

t0 = time.time()
tts = TTS()
print(f"loaded in {time.time() - t0:.1f}s")

style = tts.get_voice_style("F1")

for label, kwargs in [
    ("default", {}),  # total_steps=8, speed=1.05
    ("speed1p0", {"speed": 1.0}),
    ("steps4", {"total_steps": 4}),
]:
    t1 = time.time()
    audio, _ = tts.synthesize(TEXT, style, **kwargs)
    elapsed = time.time() - t1
    samples = int(audio.size)
    seconds = samples / 44100
    tts.save_audio(audio, f"spikes/supertonic-chain/reference-{label}.wav")
    print(f"  {label:<10} {seconds:.2f}s audio in {elapsed:.1f}s ({seconds / elapsed:.2f}x realtime)")
