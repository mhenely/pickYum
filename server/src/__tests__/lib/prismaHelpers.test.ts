import { userMinimalSelect, eventOptionsInclude } from '../../lib/prismaHelpers';

describe('userMinimalSelect', () => {
  it('selects id + username only — no email, no auth metadata', () => {
    expect(userMinimalSelect).toEqual({ id: true, username: true });
  });

  it('is a readonly literal so the type narrows correctly', () => {
    // Compile-time check: this would fail typecheck if userMinimalSelect
    // weren't `as const`. Runtime, we just verify the keys are exactly
    // these two.
    expect(Object.keys(userMinimalSelect).sort()).toEqual(['id', 'username']);
  });
});

describe('eventOptionsInclude', () => {
  it('returns the full restaurant when passed true', () => {
    const shape = eventOptionsInclude(true);
    expect(shape.include.restaurant).toBe(true);
    expect(shape.include.addedBy).toEqual({ select: userMinimalSelect });
    expect(shape.orderBy).toEqual({ createdAt: 'asc' });
  });

  it('projects the restaurant when passed a select object', () => {
    const shape = eventOptionsInclude({ id: true, name: true });
    expect(shape.include.restaurant).toEqual({ select: { id: true, name: true } });
    expect(shape.include.addedBy).toEqual({ select: userMinimalSelect });
  });

  it('produces consistent shapes for groups vs trips use cases', () => {
    // groups.ts wants the full restaurant row
    const groupShape = eventOptionsInclude(true);
    // trips.ts wants a slim projection
    const tripShape = eventOptionsInclude({
      id: true, name: true, cuisineType: true, priceLevel: true,
      address: true, lat: true, lng: true,
    });

    // Both share addedBy + orderBy semantics — only restaurant differs.
    expect(groupShape.include.addedBy).toEqual(tripShape.include.addedBy);
    expect(groupShape.orderBy).toEqual(tripShape.orderBy);
  });
});
