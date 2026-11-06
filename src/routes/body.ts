// Route helper: reads a request body with a byte cap.
// Serves NFR-2 (body limits of /api/events and /api/complete) and ADR 0007 (postback body limit).
// The cap holds while the body streams, so a body with no true Content-Length is not read in full.

// Reads at most `limit` bytes of the body; null means the body is longer.
export async function readLimited(req: Request, limit: number): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get("content-length"));
  if (declared > limit) return null;
  if (req.body === null) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
