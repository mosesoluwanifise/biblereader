/**
 * Routes Web Audio output through an <audio> element.
 *
 * Why this exists: a page playing pure Web Audio is not "media" as far as the
 * operating system is concerned. Android throttles the tab once the screen
 * locks, iOS suspends the AudioContext outright, and neither surfaces a
 * lock-screen transport — MediaSession advertises metadata and controls, but
 * it cannot keep audio alive on its own. A media element with an active
 * stream *is* recognised as media playback, which is what earns the
 * background audio session and the lock-screen controls that go with it.
 *
 * Every source connects to `node` instead of `context.destination`, that bus
 * feeds a MediaStreamAudioDestinationNode, and the resulting stream is played
 * by a hidden <audio> element. The audio graph above the bus is untouched, so
 * the sample-accurate scheduling that keeps sentences gapless still works
 * exactly as before.
 *
 * The fallback matters as much as the feature. WebAudio-to-MediaStream on a
 * media element is unevenly supported, and a silent app is far worse than one
 * that merely stops at the lock screen — so if the element refuses to play,
 * the bus is rewired straight to the speakers and playback carries on.
 */

export class MediaElementSink {
  /** The bus every AudioBufferSourceNode connects to. */
  readonly node: GainNode;

  private element: HTMLAudioElement | null = null;
  private streamDestination: MediaStreamAudioDestinationNode | null = null;
  private usingSpeakers = false;

  constructor(private readonly context: AudioContext) {
    this.node = context.createGain();

    // Not all implementations expose this; without it there is nothing to
    // route a stream through and speakers are the only option.
    if (typeof context.createMediaStreamDestination !== 'function') {
      this.connectSpeakers();
      return;
    }

    try {
      this.streamDestination = context.createMediaStreamDestination();
      this.node.connect(this.streamDestination);

      const element = document.createElement('audio');
      element.srcObject = this.streamDestination.stream;
      // Set as an attribute rather than a property: it is only typed onto
      // video elements, though Safari honours it here too. Without it iOS may
      // hand the stream to a fullscreen player.
      element.setAttribute('playsinline', '');
      element.preload = 'auto';
      // Kept out of the accessibility tree and out of the way: it is a routing
      // detail, not a control. The real transport lives in the player bar.
      element.setAttribute('aria-hidden', 'true');
      element.style.cssText = 'position:absolute;width:0;height:0;opacity:0;pointer-events:none';

      // Some browsers will not play a detached media element.
      document.body.appendChild(element);
      this.element = element;
    } catch {
      this.connectSpeakers();
    }
  }

  /**
   * Starts the element. Must be called inside the user gesture that started
   * playback — the same rule that applies to resuming the AudioContext.
   */
  activate(): void {
    if (this.usingSpeakers || !this.element) return;

    const played = this.element.play();
    // Older signatures return undefined rather than a promise.
    if (played && typeof played.catch === 'function') {
      played.catch(() => this.connectSpeakers());
    }
  }

  /** Releases the OS media session so the lock screen stops showing us. */
  pause(): void {
    this.element?.pause();
  }

  resume(): void {
    if (this.usingSpeakers) return;
    const played = this.element?.play();
    if (played && typeof played.catch === 'function') {
      played.catch(() => this.connectSpeakers());
    }
  }

  release(): void {
    this.node.disconnect();
    if (this.element) {
      this.element.pause();
      this.element.srcObject = null;
      this.element.remove();
      this.element = null;
    }
    this.streamDestination = null;
  }

  /**
   * Abandons the media-element route and sends the bus to the speakers.
   * Idempotent, because it can be reached from construction or from a play()
   * rejection that arrives later.
   */
  private connectSpeakers(): void {
    if (this.usingSpeakers) return;
    this.usingSpeakers = true;

    if (this.streamDestination) {
      try {
        this.node.disconnect(this.streamDestination);
      } catch {
        /* never connected */
      }
      this.streamDestination = null;
    }

    if (this.element) {
      this.element.pause();
      this.element.srcObject = null;
      this.element.remove();
      this.element = null;
    }

    this.node.connect(this.context.destination);
  }
}
