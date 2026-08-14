from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from server.routers import voice_cloning, tts_stream

app = FastAPI(
    title="Scripture Voice Backend API",
    description="CPU-native Pocket TTS & WhisperX alignment service for voice cloning Bible reader",
    version="1.0.0"
)

# Enable CORS for PWA client
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(voice_cloning.router)
app.include_router(tts_stream.router)

@app.get("/health")
def health_check():
    return {
        "status": "healthy",
        "engine": "Pocket TTS 100M (CPU)",
        "aligner": "WhisperX (CPU)"
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server.main:app", host="0.0.0.0", port=8000, reload=True)
