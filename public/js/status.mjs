// Why passage detection works from speed alone, in words the crew can act on:
// the fix for a missing signalk-autostate is not the fix for another source
// hiding its value.
export function fallbackMessage(stateIssue, t, format) {
  const source = stateIssue?.source ?? '?';
  switch (stateIssue?.reason) {
    case 'pending':
      return t('status.fallbackPending');
    case 'stale':
      return t('status.fallbackStale', {
        source,
        time: stateIssue.updatedAt
          ? `${format.shortDate(stateIssue.updatedAt)} ${format.time(stateIssue.updatedAt)}`
          : '?'
      });
    case 'unrecognised':
      return t('status.fallbackUnrecognised', { source, value: String(stateIssue.value) });
    default:
      return t('status.fallback');
  }
}
