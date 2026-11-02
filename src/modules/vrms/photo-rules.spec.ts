import { photoNeedOf, photoNeedUnmet, PhotoSwitches } from './photo-rules';

// Spec 0018, AC-4 to AC-8: the one photo rule both the server check and moves[].blockedBy read.

const allOn: PhotoSwitches = {
  requireBeforeToStart: true,
  requireAfterToSend: true,
  requireAfterToClose: true,
};
const allOff: PhotoSwitches = {
  requireBeforeToStart: false,
  requireAfterToSend: false,
  requireAfterToClose: false,
};

describe('photoNeedOf', () => {
  it('maps Start work to a Before photo and the two later moves to an After photo', () => {
    expect(photoNeedOf({ id: 'M3' }, allOn)).toBe('beforePhoto');
    expect(photoNeedOf({ id: 'M4' }, allOn)).toBe('afterPhoto');
    expect(photoNeedOf({ id: 'M5' }, allOn)).toBe('afterPhoto');
  });

  it('needs nothing while a switch is off', () => {
    for (const id of ['M3', 'M4', 'M5'] as const) {
      expect(photoNeedOf({ id }, allOff)).toBeNull();
    }
  });

  it.each([
    'M1',
    'M2',
    'M6',
    'M7',
    'M8',
    'M9',
    'M10',
    'M11',
    'M12',
    'M13',
    'M14',
  ] as const)('gives %s no photo rule (AC-8)', (id) => {
    expect(photoNeedOf({ id }, allOn)).toBeNull();
  });
});

describe('photoNeedUnmet', () => {
  it('is unmet only when the needed group has no live photo', () => {
    expect(photoNeedUnmet({ id: 'M3' }, allOn, { before: 0, after: 3 })).toBe(
      'beforePhoto',
    );
    expect(
      photoNeedUnmet({ id: 'M3' }, allOn, { before: 1, after: 0 }),
    ).toBeNull();
    expect(photoNeedUnmet({ id: 'M4' }, allOn, { before: 3, after: 0 })).toBe(
      'afterPhoto',
    );
    expect(
      photoNeedUnmet({ id: 'M5' }, allOn, { before: 0, after: 1 }),
    ).toBeNull();
  });

  it('is never unmet with the switch off', () => {
    expect(
      photoNeedUnmet({ id: 'M4' }, allOff, { before: 0, after: 0 }),
    ).toBeNull();
  });
});
