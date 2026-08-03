// Ingest Overture Maps places into the open_places table.
//
// Usage (run from server/, against the env of your choice):
//   # New region — fast path (batched INSERT .. ON CONFLICT DO NOTHING):
//   npx dotenv -e .env.production -- npx tsx scripts/ingest-overture.ts --file portland.geojsonseq
//
//   # Monthly refresh of an already-loaded region — upserts every row,
//   # then prunes rows inside the bbox that the new release no longer
//   # contains (closed/removed places):
//   npx dotenv -e .env.production -- npx tsx scripts/ingest-overture.ts \
//     --file portland.geojsonseq --mode refresh --prune-bbox=-123.20,45.30,-122.40,45.72
//
// Input: a GeoJSON-SEQ file (one feature per line) from the official
// Overture CLI. Produce it with:
//   pip install overturemaps
//   overturemaps download --bbox=-123.20,45.30,-122.40,45.72 \
//     -f geojsonseq --type=place -o portland.geojsonseq
//
// geojsonseq (not plain geojson) matters: the file is streamed line
// by line, so a whole-US download would ingest in constant memory.
// The transform filters to food categories (lib/overture.ts) — the
// download itself can't filter by category, so expect the input to
// contain every POI type and the ingest to keep ~10-20% of rows.
//
// Modes:
//   fast (default) — createMany + skipDuplicates: one round trip per
//     batch instead of per row (~10× faster over a remote pooler).
//     Existing rows are left untouched, so this is for FIRST loads of
//     a region, not refreshes.
//   refresh — upserts row-by-row (updates existing places in-place,
//     stamping ingestedAt) and, with --prune-bbox, deletes rows inside
//     that bbox whose ingestedAt predates this run — i.e. places the
//     new release dropped. Prune runs AFTER the ingest completes, so
//     the endpoint serves the region uninterrupted throughout.
//   --replace — wipes ALL overture rows first (every region!). Only
//     for starting over; per-region maintenance wants refresh+prune.

import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import prisma from '../src/lib/prisma';
import { transformOvertureFeature, type OpenPlaceRow } from '../src/lib/overture';

const BATCH_SIZE = 500;

interface Args {
  file: string;
  mode: 'fast' | 'refresh';
  replace: boolean;
  pruneBbox: { minLng: number; minLat: number; maxLng: number; maxLat: number } | null;
}

function usageAndExit(msg?: string): never {
  if (msg) console.error(`Error: ${msg}\n`);
  console.error(
    'Usage: tsx scripts/ingest-overture.ts --file <path.geojsonseq> ' +
    '[--mode fast|refresh] [--prune-bbox=lngMin,latMin,lngMax,latMax] [--replace]',
  );
  process.exit(1);
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const valueOf = (flag: string): string | undefined => {
    const eq = args.find((a) => a.startsWith(`${flag}=`));
    if (eq) return eq.slice(flag.length + 1);
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : undefined;
  };

  const file = valueOf('--file');
  if (!file) usageAndExit();

  const modeRaw = valueOf('--mode') ?? 'fast';
  if (modeRaw !== 'fast' && modeRaw !== 'refresh') usageAndExit(`unknown --mode "${modeRaw}"`);

  let pruneBbox: Args['pruneBbox'] = null;
  const bboxRaw = valueOf('--prune-bbox');
  if (bboxRaw) {
    if (modeRaw !== 'refresh') usageAndExit('--prune-bbox requires --mode refresh');
    const parts = bboxRaw.split(',').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
      usageAndExit(`--prune-bbox must be 4 comma-separated numbers, got "${bboxRaw}"`);
    }
    const [minLng, minLat, maxLng, maxLat] = parts;
    if (minLng >= maxLng || minLat >= maxLat) {
      usageAndExit('--prune-bbox must be lngMin,latMin,lngMax,latMax with min < max');
    }
    pruneBbox = { minLng, minLat, maxLng, maxLat };
  }

  return { file, mode: modeRaw, replace: args.includes('--replace'), pruneBbox };
}

// Poison-row isolation: a batch that fails wholesale (e.g. a row
// Postgres rejects for a reason the transform didn't sanitize) falls
// back to row-at-a-time writes, skipping only the offender. Before
// this, one bad row aborted the process and silently truncated whole
// metro loads — the endpoint then served partial regions with no
// indication anything was missing.
let skippedRows = 0;

// fast: one INSERT ... ON CONFLICT DO NOTHING per batch — one round
// trip per 500 rows. Existing rows untouched (first-load semantics).
async function flushBatchFast(batch: OpenPlaceRow[]): Promise<number> {
  try {
    const { count } = await prisma.openPlace.createMany({ data: batch, skipDuplicates: true });
    return count;
  } catch {
    let ok = 0;
    for (const row of batch) {
      try {
        const { count } = await prisma.openPlace.createMany({ data: [row], skipDuplicates: true });
        ok += count;
      } catch (err) {
        skippedRows += 1;
        console.warn(`  ! skipping row ${row.sourceId} ("${row.name.slice(0, 40)}"): ${(err as Error).message?.split('\n')[0].slice(0, 140)}`);
      }
    }
    return ok;
  }
}

// refresh: upsert-per-row inside a transaction batch — slower (one
// round trip per row) but updates existing places in place and stamps
// ingestedAt, which the prune step keys on. Same isolation fallback.
async function flushBatchRefresh(batch: OpenPlaceRow[]): Promise<number> {
  const upsertOne = (row: OpenPlaceRow) =>
    prisma.openPlace.upsert({
      where: { source_sourceId: { source: row.source, sourceId: row.sourceId } },
      create: row,
      update: { ...row, ingestedAt: new Date() },
    });
  try {
    await prisma.$transaction(batch.map(upsertOne));
    return batch.length;
  } catch {
    let ok = 0;
    for (const row of batch) {
      try { await upsertOne(row); ok += 1; }
      catch (err) {
        skippedRows += 1;
        console.warn(`  ! skipping row ${row.sourceId} ("${row.name.slice(0, 40)}"): ${(err as Error).message?.split('\n')[0].slice(0, 140)}`);
      }
    }
    return ok;
  }
}

async function main(): Promise<void> {
  const { file, mode, replace, pruneBbox } = parseArgs();
  const runStart = new Date();

  if (replace) {
    const { count } = await prisma.openPlace.deleteMany({ where: { source: 'overture' } });
    console.log(`--replace: removed ${count} existing overture rows`);
  }

  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  const flush = mode === 'fast' ? flushBatchFast : flushBatchRefresh;

  let read = 0;
  let kept = 0;
  let skippedParse = 0;
  let batch: OpenPlaceRow[] = [];
  // Dedupe within the input file — Overture occasionally emits the
  // same GERS id twice at bbox tile boundaries, and two upserts for
  // the same key inside one transaction batch would deadlock-retry.
  const seenIds = new Set<string>();

  for await (const line of rl) {
    const trimmed = line.trim();
    // geojsonseq lines may carry an RS (0x1e) prefix per RFC 8142.
    const jsonStr = trimmed.startsWith('\x1e') ? trimmed.slice(1) : trimmed;
    if (!jsonStr) continue;
    read += 1;

    let feature: unknown;
    try {
      feature = JSON.parse(jsonStr);
    } catch {
      skippedParse += 1;
      continue;
    }

    const row = transformOvertureFeature(feature);
    if (!row || seenIds.has(row.sourceId)) continue;
    seenIds.add(row.sourceId);
    batch.push(row);
    kept += 1;

    if (batch.length >= BATCH_SIZE) {
      await flush(batch);
      batch = [];
      console.log(`  …${kept} food places ingested (${read} features read)`);
    }
  }

  if (batch.length > 0) await flush(batch);

  // Prune AFTER the full ingest so the region is never partially
  // empty: every surviving place got a fresh ingestedAt above; rows
  // in the bbox still carrying an older stamp weren't in this release.
  if (pruneBbox) {
    const { count } = await prisma.openPlace.deleteMany({
      where: {
        source: 'overture',
        ingestedAt: { lt: runStart },
        lat: { gte: pruneBbox.minLat, lte: pruneBbox.maxLat },
        lng: { gte: pruneBbox.minLng, lte: pruneBbox.maxLng },
      },
    });
    console.log(`Pruned ${count} places no longer present in this release (bbox-scoped).`);
  }

  const total = await prisma.openPlace.count({ where: { source: 'overture' } });
  console.log(`Done (mode=${mode}). Read ${read} features, ingested ${kept} food places` +
    (skippedParse ? `, ${skippedParse} unparseable lines skipped` : '') +
    (skippedRows ? `, ${skippedRows} rows skipped on DB write (see warnings above)` : '') +
    `. Table now holds ${total} overture rows.`);
}

main()
  .catch((err) => { console.error('[ingest-overture] failed:', err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
