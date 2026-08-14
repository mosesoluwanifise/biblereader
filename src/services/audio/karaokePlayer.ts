import { WordTimestamp } from '../tts/types';

export class KaraokePlayer {
  private timestamps: WordTimestamp[] = [];
  private activeWordIndex: number = -1;
  private isPlaying: boolean = false;
  private animFrameId: number | null = null;
  private startTime: number = 0;
  private pausedTime: number = 0;
  private onWordChangeCallback: ((index: number) => void) | null = null;
  private onPlaybackEndCallback: (() => void) | null = null;

  public loadTimestamps(timestamps: WordTimestamp[]): void {
    this.timestamps = timestamps;
    this.activeWordIndex = -1;
    this.pausedTime = 0;
  }

  public play(onWordChange?: (index: number) => void, onEnd?: () => void): void {
    if (this.isPlaying) return;
    this.isPlaying = true;
    if (onWordChange) this.onWordChangeCallback = onWordChange;
    if (onEnd) this.onPlaybackEndCallback = onEnd;

    this.startTime = performance.now() - (this.pausedTime * 1000);
    this.tick();
  }

  public pause(): void {
    if (!this.isPlaying) return;
    this.isPlaying = false;
    this.pausedTime = (performance.now() - this.startTime) / 1000;
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
  }

  public stop(): void {
    this.pause();
    this.pausedTime = 0;
    this.activeWordIndex = -1;
    if (this.onWordChangeCallback) this.onWordChangeCallback(-1);
  }

  private tick = (): void => {
    if (!this.isPlaying) return;

    const elapsedSeconds = (performance.now() - this.startTime) / 1000;
    const newIndex = this.findWordIndexAtTime(elapsedSeconds);

    if (newIndex !== this.activeWordIndex) {
      this.activeWordIndex = newIndex;
      if (this.onWordChangeCallback) {
        this.onWordChangeCallback(newIndex);
      }
    }

    const totalDuration = this.timestamps.length > 0 ? this.timestamps[this.timestamps.length - 1].end : 0;
    if (elapsedSeconds >= totalDuration && totalDuration > 0) {
      this.stop();
      if (this.onPlaybackEndCallback) {
        this.onPlaybackEndCallback();
      }
      return;
    }

    this.animFrameId = requestAnimationFrame(this.tick);
  };

  private findWordIndexAtTime(timeSeconds: number): number {
    for (let i = 0; i < this.timestamps.length; i++) {
      if (timeSeconds >= this.timestamps[i].start && timeSeconds <= this.timestamps[i].end) {
        return i;
      }
    }
    return -1;
  }
}

export const karaokePlayer = new KaraokePlayer();
