/**
 * Lock-screen and hardware media controls.
 *
 * For a listening app this is the difference between something you use with
 * the screen on and something you use on a walk. Headphone buttons, the lock
 * screen, and car controls all route through here.
 *
 * A caveat worth stating plainly: MediaSession advertises *metadata and
 * controls*, it does not keep audio alive. Web Audio is suspended when the
 * screen locks on iOS, so on that platform these controls work while the app
 * is foregrounded and playback still stops on lock. Fixing that needs an
 * <audio> element as the output sink, which is a larger change than this.
 */

export interface MediaSessionHandlers {
  onPlay: () => void;
  onPause: () => void;
  onStop: () => void;
  onNext?: () => void;
  onPrevious?: () => void;
}

function supported(): boolean {
  return typeof navigator !== 'undefined' && 'mediaSession' in navigator;
}

export function attachMediaSession(handlers: MediaSessionHandlers): () => void {
  if (!supported()) return () => {};

  const actions: [MediaSessionAction, (() => void) | undefined][] = [
    ['play', handlers.onPlay],
    ['pause', handlers.onPause],
    ['stop', handlers.onStop],
    ['nexttrack', handlers.onNext],
    ['previoustrack', handlers.onPrevious]
  ];

  for (const [action, handler] of actions) {
    try {
      navigator.mediaSession.setActionHandler(action, handler ? () => handler() : null);
    } catch {
      // Browsers reject actions they do not implement; the rest still work.
    }
  }

  return () => {
    if (!supported()) return;
    for (const [action] of actions) {
      try {
        navigator.mediaSession.setActionHandler(action, null);
      } catch {
        /* nothing to release */
      }
    }
  };
}

export function updateMediaMetadata(book: string, chapter: number, translation: string, voice: string): void {
  if (!supported() || typeof MediaMetadata === 'undefined') return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: `${book} ${chapter}`,
      artist: voice,
      album: `${translation} — Scripture Voice`,
      artwork: [
        { src: '/icons/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icons/pwa-512x512.png', sizes: '512x512', type: 'image/png' }
      ]
    });
  } catch {
    /* metadata is a nicety, not a requirement */
  }
}

export function updatePlaybackState(state: 'playing' | 'paused' | 'none'): void {
  if (!supported()) return;
  try {
    navigator.mediaSession.playbackState = state;
  } catch {
    /* not fatal */
  }
}
