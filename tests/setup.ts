import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// jsdom implements none of these, and all are load-bearing for the reader:
// auto-scroll to the active word (U9), the jump to the top of a hand-picked
// chapter, and the reduced-motion opt-out. scrollTo reports "Not implemented"
// through the virtual console rather than throwing, so it cannot be guarded at
// the call site — it has to be replaced here.
Element.prototype.scrollIntoView = vi.fn();
window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn()
  })) as unknown as typeof window.matchMedia;
}
