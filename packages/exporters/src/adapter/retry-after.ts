// RFC 9110 section 10.2.3: Retry-After is either delay-seconds (one or more digits) or an
// HTTP-date. Returns the wait in milliseconds from `nowMs`, 0 for a date already past, or null for
// a missing or malformed header, which the caller treats as "no advice".
const HTTP_DATE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

export function parseRetryAfter(header: string | null | undefined, nowMs: number): number | null {
  if (header === null || header === undefined) return null;
  const text = header.trim();
  if (/^\d+$/.test(text)) {
    const seconds = Number(text);
    return Number.isSafeInteger(seconds) ? seconds * 1_000 : null;
  }
  if (!HTTP_DATE.test(text)) return null;
  const at = Date.parse(text);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - nowMs);
}
