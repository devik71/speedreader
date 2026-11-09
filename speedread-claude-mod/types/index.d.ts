/** One captured answer: the raw Markdown and where the reader stands in it. */
export type SavedDoc = {
  id: number;
  raw: string;
  capturedAt: number;
  blockIndex: number;
  wordIndex: number;
};

declare module 'claude-code' {
  interface PluginState {
    speedread: {
      /** The latest captured answers, oldest first. */
      docs: Shaped<SavedDoc[]>;
      /** Index into `docs` of the answer being read; -1 for none. */
      selected: number;
      wpm: number;
      playing: boolean;
      /** Hold-to-scrub direction: 1 forward (j), -1 back (k), 0 none. */
      scrub: number;
      paneOpen: boolean;
      /** Ids handed out so far; the next capture takes one more. */
      sequence: number;
    };
  }
}
