import { getDocumentProxy, extractText } from "unpdf";

export interface PageText {
  page: number;
  text: string;
}

export interface ExtractedDoc {
  text: string;
  pages: PageText[];
}

/**
 * Extract text from a PDF using unpdf (a modern, resilient pdf.js build).
 * Replaces the old pdf-parse, which bundled a ~2017 pdf.js that rejected valid
 * PDFs (malformed-but-recoverable xref, comments in the trailer, ASCII85+Flate).
 */
export async function extractPdfText(buffer: Buffer): Promise<ExtractedDoc> {
  let perPage: string[];
  try {
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { text } = await extractText(pdf, { mergePages: false });
    perPage = Array.isArray(text) ? text : [text];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/password|encrypt/i.test(msg)) {
      throw new Error("This PDF is password-protected or encrypted, so its text can't be read.");
    }
    throw new Error(`Could not read this PDF: ${msg}`);
  }

  const pages: PageText[] = perPage
    .map((t, i) => ({ page: i + 1, text: (t ?? "").trim() }))
    .filter((p) => p.text.length > 0);

  const fullText = pages.map((p) => p.text).join("\n\f");

  if (fullText.trim().length === 0) {
    throw new Error(
      "No text found in this PDF. It may be image-only (scanned) — that needs OCR, which isn't supported yet.",
    );
  }

  return { text: fullText, pages };
}
