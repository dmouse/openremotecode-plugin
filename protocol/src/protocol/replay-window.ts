const WORD_BITS = 32;
const DEFAULT_WINDOW = 1024;

/**
 * Sliding anti-replay window over a peer's envelope sequence numbers, in the
 * shape RFC 6479 describes: the highest accepted sequence plus a bitmap of the
 * window below it, so replays are rejected without the window growing and
 * genuine reordering inside the window still passes.
 */
export class ReplayWindow {
  readonly #size: number;
  readonly #bits: Uint32Array;
  #highest = -1;

  constructor(size: number = DEFAULT_WINDOW) {
    if (!Number.isSafeInteger(size) || size <= 0 || size % WORD_BITS !== 0) {
      throw new Error("Replay window size must be a positive multiple of 32");
    }
    this.#size = size;
    this.#bits = new Uint32Array(size / WORD_BITS);
  }

  get highest(): number {
    return this.#highest;
  }

  /** Records `sequence` and returns true, or returns false if it is a replay or has fallen out of the window. */
  accept(sequence: number): boolean {
    if (!Number.isSafeInteger(sequence) || sequence < 0) return false;
    if (sequence > this.#highest) {
      if (this.#highest >= 0) this.#shift(sequence - this.#highest);
      this.#highest = sequence;
      this.#mark(0);
      return true;
    }
    const offset = this.#highest - sequence;
    if (offset >= this.#size || this.#marked(offset)) return false;
    this.#mark(offset);
    return true;
  }

  #mark(offset: number): void {
    const word = offset >>> 5;
    this.#bits[word] = ((this.#bits[word] ?? 0) | (1 << (offset & 31))) >>> 0;
  }

  #marked(offset: number): boolean {
    return ((this.#bits[offset >>> 5] ?? 0) & (1 << (offset & 31))) !== 0;
  }

  #shift(distance: number): void {
    if (distance >= this.#size) {
      this.#bits.fill(0);
      return;
    }
    const words = Math.floor(distance / WORD_BITS);
    const bits = distance % WORD_BITS;
    for (let index = this.#bits.length - 1; index >= 0; index--) {
      const high = index - words >= 0 ? this.#bits[index - words] ?? 0 : 0;
      if (bits === 0) {
        this.#bits[index] = high;
        continue;
      }
      const low = index - words - 1 >= 0 ? this.#bits[index - words - 1] ?? 0 : 0;
      this.#bits[index] = ((high << bits) | (low >>> (WORD_BITS - bits))) >>> 0;
    }
  }
}
