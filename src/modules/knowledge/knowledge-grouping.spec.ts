import { groupPairs, withoutSystemPrefix } from './knowledge-grouping';

// The catalog default for knowledge.group_min_size (spec 0012)
const MIN_SIZE = 3;

// Spec 0007, Grouping and AC-32.

const day = (n: number) => new Date(Date.UTC(2026, 9, n));
const candidates = (ids: string[]) =>
  ids.map((id, i) => ({ id, createdAt: day(i + 1) }));

describe('groupPairs', () => {
  it('joins pairs into connected groups, even when not every pair is similar', () => {
    // a~b and b~c make one group of three though a and c never paired
    const groups = groupPairs(
      candidates(['a', 'b', 'c', 'd']),
      [
        { a: 'a', b: 'b' },
        { a: 'b', b: 'c' },
      ],
      MIN_SIZE,
    );
    expect(groups).toHaveLength(1);
    expect(new Set(groups[0])).toEqual(new Set(['a', 'b', 'c']));
  });

  it('drops groups under GROUP_MIN_SIZE (3)', () => {
    expect(
      groupPairs(candidates(['a', 'b', 'c']), [{ a: 'a', b: 'b' }], MIN_SIZE),
    ).toEqual([]);
  });

  it('sorts biggest first, then the group with the newest issue', () => {
    const ids = ['a1', 'a2', 'a3', 'b1', 'b2', 'b3', 'c1', 'c2', 'c3', 'c4'];
    const groups = groupPairs(
      candidates(ids),
      [
        { a: 'a1', b: 'a2' },
        { a: 'a2', b: 'a3' },
        { a: 'b1', b: 'b2' },
        { a: 'b2', b: 'b3' },
        { a: 'c1', b: 'c2' },
        { a: 'c2', b: 'c3' },
        { a: 'c3', b: 'c4' },
      ],
      MIN_SIZE,
    );
    expect(groups.map((g) => g.length)).toEqual([4, 3, 3]);
    // b3 is newer than a3, so the b group comes before the a group
    expect(groups[1]).toContain('b3');
  });

  it('lists each group newest first', () => {
    const groups = groupPairs(
      candidates(['x', 'y', 'z']),
      [
        { a: 'x', b: 'y' },
        { a: 'y', b: 'z' },
      ],
      MIN_SIZE,
    );
    expect(groups[0]).toEqual(['z', 'y', 'x']);
  });

  it('ignores pairs that name an issue outside the candidates', () => {
    const groups = groupPairs(
      candidates(['a', 'b']),
      [
        { a: 'a', b: 'b' },
        { a: 'b', b: 'gone' },
      ],
      MIN_SIZE,
    );
    expect(groups).toEqual([]);
  });
});

describe('withoutSystemPrefix', () => {
  it('drops the "[System] " the repair form writes', () => {
    expect(withoutSystemPrefix('[Brakes] Wear and tear: squeal')).toBe(
      'Wear and tear: squeal',
    );
    expect(withoutSystemPrefix('No prefix here')).toBe('No prefix here');
  });
});
