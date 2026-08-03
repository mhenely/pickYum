// Ingest Overture Maps places into the open_places table.
//
// Usage (run from server/, against the env of your choice):
//   npx dotenv -e .env.production -- npx tsx scripts/ingest-overture.ts --file portland.geojsonseq
//   npx dotenv -e .env.production -- npx tsx scripts/ingest-overture.ts --file portland.geojsonseq --replace
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
// Idempotent: rows upsert on the (source, sourceId) unique key, so
// re-running the same file — or a newer Overture release for the
// same area — updates in place. --replace wipes existing overture
// rows first (use when narrowing the bbox, otherwise out-of-bbox
// strays linger).

import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import prisma from '../src/lib/prisma';
import { transformOvertureFeature, type OpenPlaceRow } from '../src/lib/overture';

const BATCH_SIZE = 500;

function parseArgs(): { file: string; replace: boolean } {
  const args = process.argv.slice(2);
  const fileIdx = args.indexOf('--file');
  const file = fileIdx >= 0 ? args[fileIdx + 1] : undefined;
  if (!file) {
    console.error('Usage: tsx scripts/ingest-overture.ts --file <path.geojsonseq> [--replace]');
    process.exit(1);
  }
  return { file, replace: args.includes('--replace') };
}

// createMany({ skipDuplicates }) would be faster but silently keeps
// stale rows when re-ingesting a newer release. Upsert-per-row in a
// transaction batch keeps releases refreshable at metro-scale cost
// (~10-20K food rows = a few minutes) — fine for a script run
// occasionally by hand.
async function flushBatch(batch: OpenPlaceRow[]): Promise<void> {
  await prisma.$transaction(
    batch.map((row) =>
      prisma.openPlace.upsert({
        where: { source_sourceId: { source: row.source, sourceId: row.sourceId } },
        create: row,
        update: { ...row, ingestedAt: new Date() },
      }),
    ),
  );
}

async function main(): Promise<void> {
  const { file, replace } = parseArgs();

  if (replace) {
    const { count } = await prisma.openPlace.deleteMany({ where: { source: 'overture' } });
    console.log(`--replace: removed ${count} existing overture rows`);
  }

  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });

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
      await flushBatch(batch);
      batch = [];
      console.log(`  …${kept} food places ingested (${read} features read)`);
    }
  }

  if (batch.length > 0) await flushBatch(batch);

  const total = await prisma.openPlace.count({ where: { source: 'overture' } });
  console.log(`Done. Read ${read} features, ingested ${kept} food places` +
    (skippedParse ? `, ${skippedParse} unparseable lines skipped` : '') +
    `. Table now holds ${total} overture rows.`);
}

main()
  .catch((err) => { console.error('[ingest-overture] failed:', err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
