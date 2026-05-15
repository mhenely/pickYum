import prisma from './prisma';

// ── Brand palette ──────────────────────────────────────────────────
// Fixed 8-color allowlist for FavoriteList.color. We accept these
// exact strings (lowercased hex including the leading "#") or null.
// Keeping the palette small forces a cohesive look across lists and
// avoids the "everyone picks fluorescent magenta" outcome of a free
// hex input.
//
// Adding a color = add it here AND in the matching client palette
// (src/utils/favoriteLists.js LIST_COLOR_PALETTE). The server is the
// source of truth — the client uses these for the picker UI only.
export const LIST_COLOR_PALETTE: ReadonlyArray<string> = [
  '#ff8800', // orange — brand primary
  '#ef4444', // red
  '#3b82f6', // blue
  '#10b981', // green
  '#8b5cf6', // purple
  '#ec4899', // pink
  '#f59e0b', // amber
  '#64748b', // slate
];

const PALETTE_SET = new Set(LIST_COLOR_PALETTE);

// Input caps. Sized to be generous for real human labels while
// keeping a hostile client from storing megabytes per row.
export const MAX_LIST_NAME_LEN        = 80;
export const MAX_LIST_DESCRIPTION_LEN = 280;
export const MAX_LIST_ENTRY_NOTE_LEN  = 280;
// Soft cap. 50 named lists is far past anything a real user needs;
// stops abuse + keeps the management modal usable.
export const MAX_LISTS_PER_USER       = 50;
export const DEFAULT_LIST_NAME        = 'My Favorites';

// Normalize-and-validate a user-supplied color value.
//   - null / undefined / empty string → null (uses the UI's
//     default neutral chip color)
//   - matches a palette entry (case-insensitive) → lowercase hex
//   - anything else → throws InvalidColorError
//
// Case-insensitive so a client that sends "#FF8800" doesn't trip on
// our lowercase canonical. Stored as the lowercase form so equality
// queries remain stable.
export class InvalidColorError extends Error {
  constructor() { super('Invalid list color'); this.name = 'InvalidColorError'; }
}

export function normalizeColor(input: unknown): string | null {
  if (input === null || input === undefined || input === '') return null;
  if (typeof input !== 'string') throw new InvalidColorError();
  const lower = input.toLowerCase();
  if (!PALETTE_SET.has(lower)) throw new InvalidColorError();
  return lower;
}

// Centralized payload-builder for a FavoriteList row plus its
// entries. Used by every endpoint that returns a list to the client
// AND by /me/all. Keeping the shape in one place means the frontend
// slice only needs one parser.
export function serializeList<T extends {
  id: number;
  userId: number | null;
  groupId: number | null;
  name: string;
  description: string | null;
  color: string | null;
  isDefault: boolean;
  position: number;
  createdAt: Date;
  entries: Array<{ restaurantId: number; note: string | null; addedAt: Date }>;
}>(list: T) {
  return {
    id:          list.id,
    name:        list.name,
    description: list.description,
    color:       list.color,
    isDefault:   list.isDefault,
    position:    list.position,
    createdAt:   list.createdAt,
    entries: list.entries.map((e) => ({
      restaurantId: e.restaurantId,
      note:         e.note,
      addedAt:      e.addedAt,
    })),
  };
}

// Same select shape used everywhere we fetch a list for a response.
// Centralized so endpoints can't drift on which columns the client
// gets back.
export const LIST_WITH_ENTRIES_SELECT = {
  id: true,
  userId: true,
  groupId: true,
  name: true,
  description: true,
  color: true,
  isDefault: true,
  position: true,
  createdAt: true,
  entries: {
    select: {
      restaurantId: true,
      note: true,
      addedAt: true,
    },
    orderBy: { addedAt: 'desc' as const },
  },
} as const;

// Idempotent default-list bootstrapper. Used by:
//   - /api/auth/register (fire on every new account)
//   - /api/users/me/favorite-lists (defensive — covers any legacy
//     user from before this rollout, or any account whose default
//     was somehow deleted out of band)
//
// Safe to call repeatedly: the per-user-name unique constraint kicks
// in if "My Favorites" already exists, in which case we look up the
// existing default and return it. Returns the list id so callers can
// chain entry-inserts.
export async function ensureDefaultFavoriteList(userId: number): Promise<number> {
  // Fast path: existing default already there.
  const existing = await prisma.favoriteList.findFirst({
    where: { userId, isDefault: true },
    select: { id: true },
  });
  if (existing) return existing.id;

  // No default flagged yet. Try to create one named DEFAULT_LIST_NAME.
  // The race with a parallel call is harmless — one wins, the other
  // hits P2002 and falls through to the lookup branch.
  try {
    const created = await prisma.favoriteList.create({
      data: {
        userId,
        name: DEFAULT_LIST_NAME,
        isDefault: true,
        position: 0,
      },
      select: { id: true },
    });
    return created.id;
  } catch (err) {
    // Two ways we get here:
    //   - P2002 on (userId, name): a list named "My Favorites"
    //     already exists for this user. They may have created it
    //     manually pre-default-bootstrap. Promote it.
    //   - Anything else: rethrow.
    if (typeof err === 'object' && err && 'code' in err && (err as { code: string }).code === 'P2002') {
      const promoted = await prisma.favoriteList.findFirst({
        where: { userId, name: DEFAULT_LIST_NAME },
        select: { id: true },
      });
      if (promoted) {
        await prisma.favoriteList.update({
          where: { id: promoted.id },
          data:  { isDefault: true },
        });
        return promoted.id;
      }
    }
    throw err;
  }
}
