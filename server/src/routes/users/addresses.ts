// Address book CRUD:
//   - GET    /me/addresses
//   - POST   /me/addresses
//   - PATCH  /me/addresses/:id
//   - DELETE /me/addresses/:id
//
// Each user keeps a small list of named locations (Home, Work, etc.)
// for one-click prefill on the Search page. Exactly one address can be
// marked `isDefault` — enforced application-side in the writes below,
// which clear other defaults inside a transaction whenever a new
// default is set.
//
// Auth + writeLimiter are applied by the parent router in ./index.ts.

import { Router, Request, Response } from 'express';
import prisma from '../../lib/prisma';
import { parseNumericId } from '../../lib/validators';

const router = Router();

const MAX_LABEL_LEN          = 64;
const MAX_ADDRESS_BOOK_ENTRY = 256;
const MAX_ADDRESSES_PER_USER = 10;

// GET /api/users/me/addresses
router.get('/me/addresses', async (req: Request, res: Response) => {
  const addresses = await prisma.savedAddress.findMany({
    where: { userId: req.userId },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
  });
  res.json({ addresses });
});

// POST /api/users/me/addresses
router.post('/me/addresses', async (req: Request, res: Response) => {
  const { label, address, isDefault } = req.body as {
    label?: string;
    address?: string;
    isDefault?: boolean;
  };
  const trimmedLabel   = typeof label   === 'string' ? label.trim()   : '';
  const trimmedAddress = typeof address === 'string' ? address.trim() : '';

  if (!trimmedLabel)   { res.status(400).json({ error: 'label is required' }); return; }
  if (!trimmedAddress) { res.status(400).json({ error: 'address is required' }); return; }
  if (trimmedLabel.length   > MAX_LABEL_LEN)          { res.status(400).json({ error: `label must be ${MAX_LABEL_LEN} characters or fewer` }); return; }
  if (trimmedAddress.length > MAX_ADDRESS_BOOK_ENTRY) { res.status(400).json({ error: `address must be ${MAX_ADDRESS_BOOK_ENTRY} characters or fewer` }); return; }

  // Soft cap — keeps the UI dropdown short and rules out runaway entries.
  const count = await prisma.savedAddress.count({ where: { userId: req.userId } });
  if (count >= MAX_ADDRESSES_PER_USER) {
    res.status(400).json({ error: `Address book is limited to ${MAX_ADDRESSES_PER_USER} entries — delete one to add another` });
    return;
  }

  // If this is being set as default, demote any existing default
  // atomically so the "exactly one default" invariant holds.
  const willBeDefault = isDefault === true || count === 0; // first entry auto-defaults
  try {
    const created = await prisma.$transaction(async (tx) => {
      if (willBeDefault) {
        await tx.savedAddress.updateMany({
          where: { userId: req.userId, isDefault: true },
          data:  { isDefault: false },
        });
      }
      return tx.savedAddress.create({
        data: {
          userId: req.userId,
          label: trimmedLabel,
          address: trimmedAddress,
          isDefault: willBeDefault,
        },
      });
    });
    res.status(201).json({ address: created });
  } catch (err: unknown) {
    // P2002 = unique constraint (userId, label) violation
    if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'P2002') {
      res.status(409).json({ error: 'You already have an address with that label' });
      return;
    }
    throw err;
  }
});

// PATCH /api/users/me/addresses/:id
router.patch('/me/addresses/:id', async (req: Request, res: Response) => {
  const id = parseNumericId(req.params.id);
  if (!id) { res.status(400).json({ error: 'Invalid address id' }); return; }

  const { label, address, isDefault } = req.body as {
    label?: string;
    address?: string;
    isDefault?: boolean;
  };

  // Confirm ownership first — keeps the response shape consistent (404)
  // for both "doesn't exist" and "belongs to another user", so a fishing
  // probe can't enumerate ids.
  const existing = await prisma.savedAddress.findUnique({ where: { id } });
  if (!existing || existing.userId !== req.userId) {
    res.status(404).json({ error: 'Address not found' }); return;
  }

  const data: Record<string, unknown> = {};
  if (typeof label === 'string') {
    const trimmed = label.trim();
    if (!trimmed)                       { res.status(400).json({ error: 'label cannot be empty' }); return; }
    if (trimmed.length > MAX_LABEL_LEN) { res.status(400).json({ error: `label must be ${MAX_LABEL_LEN} characters or fewer` }); return; }
    data.label = trimmed;
  }
  if (typeof address === 'string') {
    const trimmed = address.trim();
    if (!trimmed)                                { res.status(400).json({ error: 'address cannot be empty' }); return; }
    if (trimmed.length > MAX_ADDRESS_BOOK_ENTRY) { res.status(400).json({ error: `address must be ${MAX_ADDRESS_BOOK_ENTRY} characters or fewer` }); return; }
    data.address = trimmed;
  }

  // Promoting this row to default? Demote others atomically.
  const promotingToDefault = isDefault === true && !existing.isDefault;
  if (isDefault === true)  data.isDefault = true;
  // Refuse demotion to false — the only valid way to "lose" default is
  // to set another row as default (which will demote this one). This
  // keeps the invariant "exactly one default exists when ≥1 addresses".
  if (isDefault === false && existing.isDefault) {
    res.status(400).json({ error: 'Set another address as default instead of clearing this one' });
    return;
  }

  try {
    const updated = await prisma.$transaction(async (tx) => {
      if (promotingToDefault) {
        await tx.savedAddress.updateMany({
          where: { userId: req.userId, isDefault: true, NOT: { id } },
          data:  { isDefault: false },
        });
      }
      return tx.savedAddress.update({ where: { id }, data });
    });
    res.json({ address: updated });
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'P2002') {
      res.status(409).json({ error: 'You already have an address with that label' });
      return;
    }
    throw err;
  }
});

// DELETE /api/users/me/addresses/:id
router.delete('/me/addresses/:id', async (req: Request, res: Response) => {
  const id = parseNumericId(req.params.id);
  if (!id) { res.status(400).json({ error: 'Invalid address id' }); return; }

  // Same ownership-or-404 pattern as PATCH.
  const existing = await prisma.savedAddress.findUnique({ where: { id } });
  if (!existing || existing.userId !== req.userId) {
    res.status(404).json({ error: 'Address not found' }); return;
  }

  // If we're deleting the current default, promote the oldest remaining
  // entry so the "exactly one default" invariant is preserved.
  // (Strictly: "at most one default with ≥1 addresses; zero if empty.")
  await prisma.$transaction(async (tx) => {
    await tx.savedAddress.delete({ where: { id } });
    if (existing.isDefault) {
      const next = await tx.savedAddress.findFirst({
        where: { userId: req.userId },
        orderBy: { createdAt: 'asc' },
      });
      if (next) {
        await tx.savedAddress.update({ where: { id: next.id }, data: { isDefault: true } });
      }
    }
  });

  res.json({ message: 'Address deleted' });
});

export default router;
