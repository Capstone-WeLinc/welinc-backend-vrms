import {
  EncryptedPDFError,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFPage,
  PDFRef,
  PDFString,
} from 'pdf-lib';
import { Semaphore } from './semaphore';

// Spec 0017, AC-7: every stored PDF is a rebuilt one (disarm and rebuild). Only the pages and
// their content survive, plus plain web, mail and phone links. No scripts, actions or attachments.

export const MAX_PDF_PAGES = 20;
const MAX_LINK_LENGTH = 2048;
const SAFE_LINK = /^(https?|mailto|tel):/i;

/** Page entries dropped before a page is copied: actions, articles and private data. */
const DROPPED_PAGE_KEYS = [
  'AA',
  'Annots',
  'B',
  'Thumb',
  'PieceInfo',
  'Metadata',
  'StructParents',
  'Trans',
  'PresSteps',
];

export type ProcessedPdf = {
  body: Buffer;
  mimeType: 'application/pdf';
  pageCount: number;
};

/** Encrypted, including owner password only PDFs (422 FILE_ENCRYPTED). */
export class EncryptedPdfError extends Error {
  constructor() {
    super('PDF is encrypted');
    this.name = 'EncryptedPdfError';
  }
}

/** Fewer than 1 or more than 20 pages (422 PDF_TOO_MANY_PAGES). */
export class PdfPageCountError extends Error {
  constructor(readonly pageCount: number) {
    super(`PDF has ${pageCount} pages`);
    this.name = 'PdfPageCountError';
  }
}

/** Any other parse or rebuild failure (422 FILE_UNREADABLE). */
export class UnreadablePdfError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('PDF could not be read', options);
    this.name = 'UnreadablePdfError';
  }
}

// Per replica, like the image slots: at most 2 PDFs rebuild at once
const pdfSlots = new Semaphore(2);

const PDF_MAGIC = Buffer.from('%PDF-', 'latin1');

/**
 * pdf-lib ships as ES5, so its EncryptedPDFError loses its prototype and `instanceof` is always
 * false. It is recognised by its message instead (the test for encrypted PDFs pins this).
 */
function isEncryptedLoadError(error: unknown): boolean {
  return (
    error instanceof EncryptedPDFError ||
    (error instanceof Error && /\bis encrypted\b/.test(error.message))
  );
}

export function processPdf(input: Buffer): Promise<ProcessedPdf> {
  return pdfSlots.run(() => rebuild(input));
}

async function rebuild(input: Buffer): Promise<ProcessedPdf> {
  if (!input.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
    throw new UnreadablePdfError();
  }

  let source: PDFDocument;
  try {
    source = await PDFDocument.load(input, {
      ignoreEncryption: false,
      updateMetadata: false,
    });
  } catch (cause) {
    if (isEncryptedLoadError(cause)) throw new EncryptedPdfError();
    throw new UnreadablePdfError({ cause });
  }
  // load() only throws on /Encrypt when asked to; check again so nothing slips through
  if (source.isEncrypted) throw new EncryptedPdfError();

  let pageCount: number;
  try {
    pageCount = source.getPageCount();
  } catch (cause) {
    throw new UnreadablePdfError({ cause });
  }
  if (pageCount < 1 || pageCount > MAX_PDF_PAGES) {
    throw new PdfPageCountError(pageCount);
  }

  try {
    flattenForm(source);
    const pages = source.getPages();
    const links = pages.map((page) => safeLinks(page));
    for (const page of pages) {
      for (const key of DROPPED_PAGE_KEYS) page.node.delete(PDFName.of(key));
    }

    // A new document: its catalog has no JavaScript, OpenAction, EmbeddedFiles or AcroForm
    const output = await PDFDocument.create({ updateMetadata: false });
    const copied = await output.copyPages(
      source,
      pages.map((_, i) => i),
    );
    copied.forEach((page, i) => {
      output.addPage(page);
      addLinks(output, page, links[i]);
    });

    const body = Buffer.from(await output.save({ useObjectStreams: true }));
    return { body, mimeType: 'application/pdf', pageCount };
  } catch (cause) {
    throw new UnreadablePdfError({ cause });
  }
}

/** Form fields become plain page content. Best effort: a broken form keeps its pages. */
function flattenForm(doc: PDFDocument) {
  try {
    const form = doc.getForm();
    if (form.getFields().length > 0) form.flatten();
  } catch {
    // The widgets are dropped with every other annotation anyway
  }
}

type SafeLink = { rect: number[]; uri: string };

/** The page's /Link annotations whose action is a /URI with an allowed scheme, as plain values. */
function safeLinks(page: PDFPage): SafeLink[] {
  const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
  if (!annots) return [];
  const links: SafeLink[] = [];
  for (let i = 0; i < annots.size(); i++) {
    const annot = annots.lookupMaybe(i, PDFDict);
    if (!annot) continue;
    if (annot.get(PDFName.of('Subtype')) !== PDFName.of('Link')) continue;
    const action = annot.lookupMaybe(PDFName.of('A'), PDFDict);
    if (!action || action.get(PDFName.of('S')) !== PDFName.of('URI')) continue;
    const uri = action.lookupMaybe(PDFName.of('URI'), PDFString, PDFHexString);
    const rect = annot.lookupMaybe(PDFName.of('Rect'), PDFArray);
    if (!uri || !rect || rect.size() !== 4) continue;

    const value = uri.decodeText().trim();
    if (
      value.length === 0 ||
      value.length > MAX_LINK_LENGTH ||
      !SAFE_LINK.test(value) ||
      // A URI is plain ASCII; anything else is dropped rather than guessed at

      /[^\x21-\x7e]/.test(value)
    ) {
      continue;
    }
    const numbers = rect
      .asArray()
      .map((n) => (n instanceof PDFNumber ? n.asNumber() : NaN));
    if (numbers.some((n) => !Number.isFinite(n))) continue;
    links.push({ rect: numbers, uri: value });
  }
  return links;
}

/** Each kept link as a fresh, minimal annotation: no appearance, no other action, no chain. */
function addLinks(doc: PDFDocument, page: PDFPage, links: SafeLink[]) {
  if (links.length === 0) return;
  const refs: PDFRef[] = links.map((link) =>
    doc.context.register(
      doc.context.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: link.rect,
        Border: [0, 0, 0],
        A: {
          Type: 'Action',
          S: 'URI',
          URI: PDFHexString.of(Buffer.from(link.uri, 'latin1').toString('hex')),
        },
      }),
    ),
  );
  page.node.set(PDFName.of('Annots'), doc.context.obj(refs));
}
