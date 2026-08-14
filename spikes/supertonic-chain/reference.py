from supertonic import TTS
import time
t0 = time.time()
tts = TTS()
print("loaded in %.1fs" % (time.time() - t0))
t1 = time.time()
tts.synthesize(
    "In the beginning God created the heaven and the earth.",
    voice="F1",
    output_path="spikes/supertonic-chain/reference-F1.wav",
)
print("synthesized in %.1fs" % (time.time() - t1))
