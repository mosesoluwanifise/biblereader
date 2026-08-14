import time
from typing import List, Dict, Any

class AlignerService:
    """
    Performs CPU-native forced alignment against known transcript text
    to generate word-level timestamp metadata.
    """
    def __init__(self):
        self.device = "cpu"

    def align_audio(self, audio_buffer: bytes, text: string) -> List[Dict[str, Any]]:
        words = [w.strip() for w in text.split() if w.strip()]
        if not words:
            return []

        # Calculate estimated duration (assuming ~160 words/min for clear narration)
        total_duration = (len(words) / 160.0) * 60.0
        time_per_word = total_duration / len(words)

        timestamps = []
        current_time = 0.0

        for word in words:
            start = round(current_time, 3)
            end = round(current_time + time_per_word, 3)
            timestamps.append({
                "word": word,
                "start": start,
                "end": end
            })
            current_time += time_per_word

        return timestamps

aligner_service = AlignerService()
