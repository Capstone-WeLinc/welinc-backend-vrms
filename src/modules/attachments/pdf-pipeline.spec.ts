import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFString,
  StandardFonts,
} from 'pdf-lib';
import sharp from 'sharp';
import {
  EncryptedPdfError,
  PdfPageCountError,
  processPdf,
  UnreadablePdfError,
} from './pdf-pipeline';

// Spec 0017, AC-7: fixtures are built here with pdf-lib, so no binary files live in the repo.

async function bytes(doc: PDFDocument) {
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

async function pages(n: number) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < n; i++) doc.addPage([300, 400]);
  return doc;
}

function linkAnnot(doc: PDFDocument, uri: string, extra: object = {}) {
  return doc.context.register(
    doc.context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [10, 10, 100, 30],
      A: { S: 'URI', URI: PDFString.of(uri) },
      ...extra,
    }),
  );
}

/** Every raw object in a saved PDF as text, for "the stored copy has none of X" checks. */
async function rawText(body: Buffer) {
  const doc = await PDFDocument.load(body);
  return doc.context
    .enumerateIndirectObjects()
    .map(([, obj]) => obj.toString())
    .join('\n');
}

describe('processPdf', () => {
  it('rejects bytes that do not start with %PDF-', async () => {
    await expect(processPdf(Buffer.from('hello'))).rejects.toBeInstanceOf(
      UnreadablePdfError,
    );
  });

  it('rejects a PDF header with garbage after it', async () => {
    await expect(
      processPdf(Buffer.from('%PDF-1.7\n this is not a pdf')),
    ).rejects.toBeInstanceOf(Error);
  });

  it('rejects an encrypted PDF, owner password only included', async () => {
    const doc = await pages(1);
    // An /Encrypt entry in the trailer is what marks any encrypted PDF
    doc.context.trailerInfo.Encrypt = doc.context.register(
      doc.context.obj({ Filter: 'Standard', V: 2, R: 3, P: -4 }),
    );
    await expect(processPdf(await bytes(doc))).rejects.toBeInstanceOf(
      EncryptedPdfError,
    );
  });

  it('accepts 20 pages and rejects 21', async () => {
    const ok = await processPdf(await bytes(await pages(20)));
    expect(ok.pageCount).toBe(20);
    const err = await processPdf(await bytes(await pages(21))).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PdfPageCountError);
    expect((err as PdfPageCountError).pageCount).toBe(21);
  });

  it('drops document JavaScript, OpenAction and embedded files', async () => {
    const doc = await pages(1);
    const js = doc.context.obj({
      S: 'JavaScript',
      JS: PDFString.of('app.alert("pwned")'),
    });
    doc.catalog.set(PDFName.of('OpenAction'), doc.context.register(js));
    const file = doc.context.stream('MZ evil payload', {
      Type: 'EmbeddedFile',
    });
    doc.catalog.set(
      PDFName.of('Names'),
      doc.context.obj({
        JavaScript: { Names: [PDFString.of('a'), doc.context.register(js)] },
        EmbeddedFiles: {
          Names: [
            PDFString.of('evil.exe'),
            doc.context.obj({
              Type: 'Filespec',
              F: PDFString.of('evil.exe'),
              EF: { F: doc.context.register(file) },
            }),
          ],
        },
      }),
    );
    await doc.attach(Buffer.from('second payload'), 'notes.txt');

    const { body } = await processPdf(await bytes(doc));
    const out = await PDFDocument.load(body);
    expect(out.catalog.get(PDFName.of('OpenAction'))).toBeUndefined();
    expect(out.catalog.get(PDFName.of('Names'))).toBeUndefined();
    const raw = await rawText(body);
    expect(raw).not.toMatch(/JavaScript|EmbeddedFile|Filespec/);
    expect(out.getPageCount()).toBe(1);
  });

  it('drops page actions and every annotation but safe URI links', async () => {
    const doc = await pages(1);
    const page = doc.getPage(0);
    page.node.set(
      PDFName.of('AA'),
      doc.context.obj({ O: { S: 'JavaScript', JS: PDFString.of('x()') } }),
    );
    page.node.set(
      PDFName.of('Annots'),
      doc.context.obj([
        linkAnnot(doc, 'https://example.com/receipt'),
        linkAnnot(doc, 'mailto:shop@example.com'),
        linkAnnot(doc, 'tel:+639171234567'),
        linkAnnot(doc, 'javascript:alert(1)'),
        linkAnnot(doc, 'file:///etc/passwd'),
        linkAnnot(doc, `https://example.com/${'a'.repeat(2100)}`),
        // A safe URI that also chains a script must lose the chain
        linkAnnot(doc, 'http://example.com/ok', {
          AA: { E: { S: 'JavaScript', JS: PDFString.of('y()') } },
        }),
        doc.context.register(
          doc.context.obj({
            Type: 'Annot',
            Subtype: 'Text',
            Rect: [0, 0, 10, 10],
            Contents: PDFString.of('a comment'),
          }),
        ),
        doc.context.register(
          doc.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: [0, 0, 10, 10],
            A: { S: 'Launch', F: PDFString.of('cmd.exe') },
          }),
        ),
      ]),
    );

    const { body } = await processPdf(await bytes(doc));
    const out = await PDFDocument.load(body);
    const outPage = out.getPage(0);
    expect(outPage.node.get(PDFName.of('AA'))).toBeUndefined();

    const annots = outPage.node.lookup(PDFName.of('Annots'), PDFArray);
    const uris = annots.asArray().map((ref) => {
      const annot = out.context.lookup(ref, PDFDict);
      expect(annot.get(PDFName.of('Subtype'))).toBe(PDFName.of('Link'));
      expect(annot.get(PDFName.of('AA'))).toBeUndefined();
      const action = annot.lookup(PDFName.of('A'), PDFDict);
      return action.lookup(PDFName.of('URI'), PDFHexString).decodeText();
    });
    expect(uris).toEqual([
      'https://example.com/receipt',
      'mailto:shop@example.com',
      'tel:+639171234567',
      'http://example.com/ok',
    ]);
    expect(await rawText(body)).not.toMatch(/JavaScript|Launch|cmd\.exe/);
  });

  it('keeps a MediaBox and Resources the page inherits from its parent', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText('Total 1,250.00', { x: 50, y: 700, font, size: 12 });
    // Move both entries up to the page tree root, so the page only inherits them
    const tree = doc.catalog.lookup(PDFName.of('Pages'), PDFDict);
    for (const key of ['MediaBox', 'Resources']) {
      tree.set(PDFName.of(key), page.node.get(PDFName.of(key))!);
      page.node.delete(PDFName.of(key));
    }

    const { body } = await processPdf(await bytes(doc));
    const outPage = (await PDFDocument.load(body)).getPage(0);
    expect(outPage.getSize()).toEqual({ width: 612, height: 792 });
    const resources = outPage.node.lookup(PDFName.of('Resources'), PDFDict);
    expect(resources.get(PDFName.of('Font'))).toBeDefined();
  });

  it('keeps a scanned, image only PDF', async () => {
    const png = await sharp({
      create: { width: 200, height: 300, channels: 3, background: '#808080' },
    })
      .png()
      .toBuffer();
    const doc = await PDFDocument.create();
    const image = await doc.embedPng(png);
    doc.addPage([200, 300]).drawImage(image, { x: 0, y: 0 });

    const { body } = await processPdf(await bytes(doc));
    const resources = (await PDFDocument.load(body))
      .getPage(0)
      .node.lookup(PDFName.of('Resources'), PDFDict);
    expect(resources.get(PDFName.of('XObject'))).toBeDefined();
  });

  it('flattens a filled form into page content and drops the form', async () => {
    const doc = await pages(1);
    const field = doc.getForm().createTextField('plate');
    field.setText('ABC 1234');
    field.addToPage(doc.getPage(0), { x: 20, y: 300, width: 150, height: 20 });

    const { body } = await processPdf(await bytes(doc));
    const out = await PDFDocument.load(body);
    expect(out.catalog.get(PDFName.of('AcroForm'))).toBeUndefined();
    expect(out.getPage(0).node.get(PDFName.of('Annots'))).toBeUndefined();
    // The flattened value lives on as a form XObject drawn on the page
    const resources = out
      .getPage(0)
      .node.lookup(PDFName.of('Resources'), PDFDict);
    expect(resources.get(PDFName.of('XObject'))).toBeDefined();
  });

  it('returns application/pdf bytes that start with %PDF-', async () => {
    const result = await processPdf(await bytes(await pages(2)));
    expect(result.mimeType).toBe('application/pdf');
    expect(result.body.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(result.pageCount).toBe(2);
  });
});
