/**
 * SharedArrayBuffer bump allocator for zero-copy data transfer between workers.
 * Only used when SharedArrayBuffer is available (Tier 1).
 */

const INITIAL_SIZE = 64 * 1024 * 1024; // 64 MB

export function hasSABSupport(): boolean {
  try {
    return (
      typeof SharedArrayBuffer !== "undefined" &&
      typeof Atomics !== "undefined"
    );
  } catch {
    return false;
  }
}

export class BumpAllocator {
  private buffer: SharedArrayBuffer;
  private offset: number;

  constructor(size: number = INITIAL_SIZE) {
    this.buffer = new SharedArrayBuffer(size);
    this.offset = 0;
  }

  /**
   * Write bytes into the shared buffer. Returns the offset and length.
   * Grows the buffer if needed.
   */
  write(data: Uint8Array): { buffer: SharedArrayBuffer; offset: number; length: number } {
    const needed = this.offset + data.byteLength;

    if (needed > this.buffer.byteLength) {
      // Grow: allocate a new SAB at least 2x the needed size
      const newSize = Math.max(needed * 2, this.buffer.byteLength * 2);
      const newBuffer = new SharedArrayBuffer(newSize);
      const oldView = new Uint8Array(this.buffer);
      const newView = new Uint8Array(newBuffer);
      newView.set(oldView.subarray(0, this.offset));
      this.buffer = newBuffer;
    }

    const view = new Uint8Array(this.buffer);
    view.set(data, this.offset);
    const result = { buffer: this.buffer, offset: this.offset, length: data.byteLength };
    this.offset += data.byteLength;
    return result;
  }

  /** Reset the allocator for the next batch (reuses the buffer). */
  reset(): void {
    this.offset = 0;
  }

  /** Get the current shared buffer reference. */
  getBuffer(): SharedArrayBuffer {
    return this.buffer;
  }
}

/** Read a region from a SharedArrayBuffer as a UTF-8 string. */
export function readRegionAsString(
  buffer: SharedArrayBuffer,
  offset: number,
  length: number
): string {
  const view = new Uint8Array(buffer, offset, length);
  return new TextDecoder().decode(view);
}
