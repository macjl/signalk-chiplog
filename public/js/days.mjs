// Grouping passages by day is a display concern (SPEC §3.2): days are local to
// the device showing the log, and a passage appears on every day it touches.

function localMidnight(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

// A date input gives a calendar day; the API wants an instant. `dayOffset` of 1
// gives the following midnight, for the exclusive end of a range.
export function rangeBoundary(value, dayOffset = 0) {
  if (!value) {
    return null;
  }
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day + dayOffset);
}

export function dayKey(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export function groupByDay(entries, now = Date.now()) {
  const days = new Map();

  for (const entry of entries) {
    const start = new Date(entry.startTime);
    // The last instant the passage covers: one ending exactly at midnight does
    // not spill onto the next day. An open passage runs up to now.
    const last = entry.endTime
      ? new Date(Math.max(start.getTime(), Date.parse(entry.endTime) - 1))
      : new Date(Math.max(now, start.getTime()));
    const startKey = dayKey(start);
    const endKey = dayKey(last);

    // Stepping the calendar date rather than adding 24 hours keeps days right
    // across daylight saving changes.
    for (
      const cursor = localMidnight(start);
      cursor <= last;
      cursor.setDate(cursor.getDate() + 1)
    ) {
      const key = dayKey(cursor);
      if (!days.has(key)) {
        days.set(key, { key, date: new Date(cursor), items: [], distance: 0 });
      }
      const day = days.get(key);
      day.items.push({
        entry,
        continuesFromPreviousDay: key !== startKey,
        continuesNextDay: key !== endKey
      });
      // A passage's distance counts on the day it started; the log holds no
      // per-day split of it.
      if (key === startKey) {
        day.distance += entry.distance ?? 0;
      }
    }
  }

  for (const day of days.values()) {
    day.items.sort((a, b) => b.entry.startTime.localeCompare(a.entry.startTime));
  }
  return [...days.values()].sort((a, b) => b.key.localeCompare(a.key));
}
