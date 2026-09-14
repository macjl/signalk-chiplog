// A tablet's clock may be far off. Entries queued offline carry the time they
// were made, so it is corrected by the server's clock, read from the Date
// header of its responses. That header has one-second resolution: offsets
// under two seconds are noise and ignored.

const NEGLIGIBLE_OFFSET_MS = 2000;

export function createServerClock({ now = Date.now } = {}) {
  let offset = 0;

  return {
    observe(dateHeader, sentAt, receivedAt) {
      const server = Date.parse(dateHeader ?? '');
      if (Number.isNaN(server)) {
        return;
      }
      // The header is truncated to the second: its midpoint is the best guess.
      offset = server + 500 - (sentAt + receivedAt) / 2;
    },

    offset() {
      return Math.abs(offset) < NEGLIGIBLE_OFFSET_MS ? 0 : offset;
    },

    now() {
      return now() + this.offset();
    }
  };
}
