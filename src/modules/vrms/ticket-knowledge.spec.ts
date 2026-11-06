import { BadRequestException } from '@nestjs/common';
import {
  checkResolutions,
  issueInclude,
  resolutionData,
} from './ticket-knowledge';

// Spec 0007, AC-31: "What fixed it" on the move to For verification.

const linked = {
  id: '00000000-0000-4000-8000-000000000001',
  description: '[Brakes] Wear and tear: grinding',
  knowledgeEntryId: 'entry-1',
};
const unlinked = {
  id: '00000000-0000-4000-8000-000000000002',
  description: '[Engine] Unknown: rough idle',
  knowledgeEntryId: null,
};

function message(fn: () => unknown) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(BadRequestException);
    return (err as BadRequestException).message;
  }
  throw new Error('expected a 400');
}

describe('checkResolutions', () => {
  it('needs one resolution for every issue and names the missing ones', () => {
    const text = message(() =>
      checkResolutions([linked, unlinked], [{ issueId: linked.id }]),
    );
    expect(text).toContain('Add what fixed each issue.');
    expect(text).toContain('rough idle');
    expect(text).not.toContain('grinding');
  });

  it('needs no resolutions sent at all to fail the same way', () => {
    expect(message(() => checkResolutions([linked], undefined))).toContain(
      'Add what fixed each issue.',
    );
  });

  it('needs a 5 to 500 character note for an unlinked issue', () => {
    const short = message(() =>
      checkResolutions(
        [linked, unlinked],
        [
          { issueId: linked.id },
          { issueId: unlinked.id, resolutionNote: '  ok  ' },
        ],
      ),
    );
    expect(short).toContain('5 to 500 characters');
    expect(short).toContain('rough idle');
  });

  it('lets a linked issue go without a note', () => {
    const byId = checkResolutions(
      [linked, unlinked],
      [
        { issueId: linked.id, hoursSpent: 2 },
        { issueId: unlinked.id, resolutionNote: 'Cleaned the idle valve' },
      ],
    );
    expect(byId.get(linked.id)).toEqual({ issueId: linked.id, hoursSpent: 2 });
  });

  it('rejects a resolution for an issue that is not on the ticket', () => {
    expect(
      message(() =>
        checkResolutions(
          [linked],
          [
            { issueId: linked.id },
            { issueId: '00000000-0000-4000-8000-000000000009' },
          ],
        ),
      ),
    ).toContain('not on this ticket');
  });
});

describe('resolutionData', () => {
  const now = new Date('2026-10-25T00:00:00Z');

  it('defaults "followed the known fix" to yes on a linked issue', () => {
    expect(
      resolutionData({ issueId: 'x', hoursSpent: 1.5 }, true, now),
    ).toEqual({
      resolutionNote: null,
      hoursSpent: 1.5,
      followedKnownFix: true,
      resolvedAt: now,
    });
  });

  it('leaves "followed" empty on an unlinked issue and trims the note', () => {
    expect(
      resolutionData(
        {
          issueId: 'x',
          resolutionNote: '  new pads  ',
          followedKnownFix: true,
        },
        false,
        now,
      ),
    ).toEqual({
      resolutionNote: 'new pads',
      hoursSpent: null,
      followedKnownFix: null,
      resolvedAt: now,
    });
  });
});

describe('issueInclude order (spec 0024, AC-4)', () => {
  it('sends issues by createdAt, then id, so issue numbers never swap', () => {
    expect(issueInclude.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
  });
});
