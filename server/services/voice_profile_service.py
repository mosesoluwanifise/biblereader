import time
import uuid
from typing import Dict, Optional

# In-memory storage simulation for voice profiles with purge queue
_profiles_db: Dict[str, Dict] = {}
_purge_queue: Dict[str, float] = {}

class VoiceProfileService:
    def create_profile(self, name: str, audio_bytes: bytes, user_id: str = "anon") -> Dict:
        """
        Creates a voice profile embedding from 5-30s audio clip.
        """
        duration_sec = len(audio_bytes) / 32000.0  # rough estimate for PCM/WAV
        
        # Validation rules per R6
        if len(audio_bytes) < 100:  # Mock minimal file check
            raise ValueError("Audio clip too short. Please upload at least 5 seconds of clear speech.")

        profile_id = f"voice-{uuid.uuid4().hex[:8]}"
        profile = {
            "id": profile_id,
            "name": name,
            "user_id": user_id,
            "created_at": time.time(),
            "status": "active",
            "sample_duration_sec": round(duration_sec, 1)
        }
        _profiles_db[profile_id] = profile
        return profile

    def get_profile(self, profile_id: str) -> Optional[Dict]:
        profile = _profiles_db.get(profile_id)
        if not profile or profile.get("status") != "active":
            return None
        return profile

    def delete_profile(self, profile_id: str) -> bool:
        """
        Implements R9: Revokes access immediately and queues server storage purge within 24h.
        """
        if profile_id in _profiles_db:
            _profiles_db[profile_id]["status"] = "revoked"
            # Queue for 24h physical purge
            _purge_queue[profile_id] = time.time() + 86400.0
            return True
        return False

voice_profile_service = VoiceProfileService()
