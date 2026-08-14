from fastapi import APIRouter, UploadFile, File, Form, HTTPException, status
from server.services.voice_profile_service import voice_profile_service

router = APIRouter(prefix="/api/v1/voices", tags=["Voice Cloning"])

@router.post("/clone", status_code=status.HTTP_201_CREATED)
async def clone_voice(
    name: str = Form(...),
    file: UploadFile = File(...)
):
    """
    R6: Accepts 5-30 second audio clip and returns a cloned voice profile.
    """
    contents = await file.read()
    if len(contents) == 0:
        raise HTTPException(status_code=400, detail="Empty audio file provided.")
    
    try:
        profile = voice_profile_service.create_profile(name, contents)
        return {
            "message": "Voice profile created successfully.",
            "profile": profile
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

@router.delete("/{voice_id}")
async def delete_voice(voice_id: str):
    """
    R9: Revokes voice access immediately and schedules backend storage purge within 24h.
    """
    success = voice_profile_service.delete_profile(voice_id)
    if not success:
        raise HTTPException(status_code=404, detail="Voice profile not found or already deleted.")
    
    return {
        "message": "Voice profile revoked immediately. Server storage will be purged within 24 hours.",
        "voice_id": voice_id
    }
