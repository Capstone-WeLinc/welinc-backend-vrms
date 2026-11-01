import {
  ATTACHMENT_KINDS,
  DOCUMENT_KINDS,
  KIND_RULES,
} from './attachment-kinds';

// Spec 0017, AC-4, AC-9, AC-15, AC-16: what each kind accepts and which right and cap it follows.

describe('KIND_RULES (AC-4)', () => {
  it('accepts photos only for a vehicle photo', () => {
    expect(KIND_RULES.VEHICLE_PHOTO.accepts).toEqual([
      'image/jpeg',
      'image/png',
      'image/heic',
    ]);
  });

  it('accepts only PDF for an other document', () => {
    expect(KIND_RULES.OTHER_DOCUMENT.accepts).toEqual(['application/pdf']);
  });

  it('accepts photos and PDF for proof and for a receipt', () => {
    for (const kind of ['PROOF', 'RECEIPT'] as const) {
      expect(KIND_RULES[kind].accepts).toContain('application/pdf');
      expect(KIND_RULES[kind].accepts).toContain('image/jpeg');
    }
  });

  it('has a rule, a label and a human readable accepts text for every kind', () => {
    expect(ATTACHMENT_KINDS.sort()).toEqual(
      ['OTHER_DOCUMENT', 'PROOF', 'RECEIPT', 'VEHICLE_PHOTO'].sort(),
    );
    for (const kind of ATTACHMENT_KINDS) {
      expect(KIND_RULES[kind].label).not.toBe('');
      expect(KIND_RULES[kind].acceptsLabel).not.toBe('');
    }
  });
});

describe('add rights and visibility (AC-15, AC-16)', () => {
  it('ties photos and proof to the files right, documents to the documents right', () => {
    expect(KIND_RULES.VEHICLE_PHOTO.addAction).toBe('addFiles');
    expect(KIND_RULES.PROOF.addAction).toBe('addFiles');
    expect(KIND_RULES.RECEIPT.addAction).toBe('addDocuments');
    expect(KIND_RULES.OTHER_DOCUMENT.addAction).toBe('addDocuments');
  });

  it('marks exactly the cost paperwork as costs only', () => {
    const costsOnly = ATTACHMENT_KINDS.filter((k) => KIND_RULES[k].costsOnly);
    expect(costsOnly.sort()).toEqual(['OTHER_DOCUMENT', 'RECEIPT']);
  });

  it('counts receipts and other documents against the document cap (AC-9)', () => {
    expect([...DOCUMENT_KINDS].sort()).toEqual(['OTHER_DOCUMENT', 'RECEIPT']);
  });
});
