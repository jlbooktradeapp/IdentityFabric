/**
 * addNPI.js — mongosh script to add the NPI attribute to all users in INTERNAL.
 *
 * Usage:
 *   1. Run prepare_npi_data.py to generate npi_lookup.json from NPIExport.csv
 *      python prepare_npi_data.py NPIExport.csv
 *
 *   2. Run this script with mongosh:
 *      mongosh "mongodb://localhost:27017/IdentityFabric" addNPI.js
 *
 * What it does:
 *   Step 1: Sets npi = "" on ALL documents in the INTERNAL collection.
 *   Step 2: Reads npi_lookup.json, matches each entry by samaccountname (case-insensitive),
 *           and sets the actual NPI value.
 */

const fs = require("fs");

const LOOKUP_FILE = "npi_lookup.json";
const COLLECTION = "Identities";

const coll = db.getCollection(COLLECTION);

// ── Step 1: Add npi = "" to every document ──────────────────────────────────
print("Step 1: Setting npi = '' on all documents...");
const blankResult = coll.updateMany({}, { $set: { npi: "" } });
print(
  `  Matched: ${blankResult.matchedCount}, Modified: ${blankResult.modifiedCount}`
);

// ── Step 2: Load CSV-derived lookup and apply NPI values ────────────────────
print(`\nStep 2: Loading NPI data from ${LOOKUP_FILE}...`);

let lookup;
try {
  const raw = fs.readFileSync(LOOKUP_FILE, "utf8");
  lookup = JSON.parse(raw);
} catch (e) {
  print(`ERROR: Could not read ${LOOKUP_FILE}: ${e.message}`);
  print(
    "  Make sure you ran: python prepare_npi_data.py NPIExport.csv"
  );
  quit(1);
}

print(`  Loaded ${lookup.length} entries. Applying updates...`);

let matched = 0;
let notFound = 0;
const missing = [];

for (const entry of lookup) {
  // Case-insensitive match on samaccountname
  const result = coll.updateOne(
    { samaccountname: { $regex: new RegExp(`^${entry.samaccountname}$`, "i") } },
    { $set: { npi: entry.npi } }
  );

  if (result.matchedCount > 0) {
    matched++;
  } else {
    notFound++;
    missing.push(entry.samaccountname);
  }
}

// ── Summary ─────────────────────────────────────────────────────────────────
print("\n═══ Summary ═══");
print(`  Total CSV entries:    ${lookup.length}`);
print(`  Matched & updated:   ${matched}`);
print(`  Not found in DB:     ${notFound}`);

if (missing.length > 0 && missing.length <= 50) {
  print("\n  Unmatched samaccountnames:");
  for (const sam of missing) {
    print(`    - ${sam}`);
  }
} else if (missing.length > 50) {
  print(`\n  First 50 unmatched samaccountnames:`);
  for (const sam of missing.slice(0, 50)) {
    print(`    - ${sam}`);
  }
  print(`  ... and ${missing.length - 50} more.`);
}

print("\nDone.");