/**
 * Who asked for an approval. Devices with a name show it; an unnamed key only
 * has its short id, which means nothing on its own.
 */
export function requesterLabel(requestedBy: string): string {
  return /^[a-f0-9]{8,}$/i.test(requestedBy)
    ? `An AI client (key ${requestedBy.slice(0, 8)})`
    : requestedBy;
}
