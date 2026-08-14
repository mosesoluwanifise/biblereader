import json
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from server.services.tts_service import pocket_tts_service
from server.services.voice_profile_service import voice_profile_service

router = APIRouter(prefix="/api/v1/tts", tags=["TTS Streaming"])

class TTSRequest(BaseModel):
    text: str
    voice_id: str

@router.post("/stream")
async def stream_tts(req: TTSRequest):
    """
    R2, R8: Streams Pocket TTS sentence audio + word timestamps over SSE.
    """
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="Text cannot be empty.")
    
    # Check if voice profile is valid
    if req.voice_id.startswith("voice-"):
        profile = voice_profile_service.get_profile(req.voice_id)
        if not profile:
            raise HTTPException(
                status_code=403, 
                detail="Cloned voice profile access revoked or deleted. Reverting to preset voice."
            )

    def event_generator():
        # Split passage into sentence chunks for streaming
        sentences = [s.strip() for s in req.text.split(".") if s.strip()]
        for sentence in sentences:
            chunk_data = pocket_tts_service.synthesize_sentence(sentence + ".", req.voice_id)
            yield f"data: {json.dumps(chunk_data)}\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")
