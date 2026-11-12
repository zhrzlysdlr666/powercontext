// The chunker the browser uses, kept in one place so the offline evaluation
// splits documents exactly the way the app does.
export const CHUNK_CHARS = 340;
export const CHUNK_OVERLAP = 60;

export function chunkText(text, max = CHUNK_CHARS, overlap = CHUNK_OVERLAP) {
  const clean = text.replace(/\r\n/g, "\n").trim();
  const paragraphs = clean.split(/\n{2,}/).map((p) => p.replace(/\s+\n/g, "\n").trim()).filter(Boolean);
  const chunks = [];
  let buffer = "";
  const push = () => {
    if (!buffer.trim()) return;
    chunks.push(buffer.trim());
    buffer = chunks.length ? buffer.slice(Math.max(0, buffer.length - overlap)) : "";
  };
  for (const paragraph of paragraphs.length ? paragraphs : [clean]) {
    if (paragraph.length > max) {
      if (buffer.trim()) push();
      const sentences = paragraph.split(/(?<=[。！？!?；;.])/);
      buffer = "";
      for (const sentence of sentences) {
        if ((buffer + sentence).length > max && buffer) push();
        buffer += sentence;
      }
      if (buffer.trim()) {
        chunks.push(buffer.trim());
        buffer = "";
      }
      continue;
    }
    if ((buffer + "\n\n" + paragraph).length > max && buffer) push();
    buffer = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
  }
  if (buffer.trim()) chunks.push(buffer.trim());
  return chunks.filter(Boolean);
}
