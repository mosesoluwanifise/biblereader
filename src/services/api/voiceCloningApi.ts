const API_BASE_URL = 'http://localhost:8000/api/v1';

export interface ClonedVoiceResponse {
  message: string;
  profile: {
    id: string;
    name: string;
    sample_duration_sec: number;
  };
}

export async function uploadVoiceSample(name: string, file: File): Promise<ClonedVoiceResponse> {
  const formData = new FormData();
  formData.append('name', name);
  formData.append('file', file);

  const response = await fetch(`${API_BASE_URL}/voices/clone`, {
    method: 'POST',
    body: formData
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ detail: 'Failed to clone voice' }));
    throw new Error(errorData.detail || 'Voice cloning failed.');
  }

  return response.json();
}

export async function deleteClonedVoice(voiceId: string): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/voices/${voiceId}`, {
    method: 'DELETE'
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ detail: 'Failed to delete voice' }));
    throw new Error(errorData.detail || 'Voice deletion failed.');
  }
}
