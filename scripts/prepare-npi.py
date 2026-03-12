"""
Convert NPIExport.csv to a clean JSON file for mongosh consumption.
Output: npi_lookup.json — array of { samaccountname, npi } objects.
"""
import csv
import json
import sys

INPUT_CSV = sys.argv[1] if len(sys.argv) > 1 else "NPIExport.csv"
OUTPUT_JSON = "npi_lookup.json"

with open(INPUT_CSV, newline="", encoding="utf-8") as f:
    reader = csv.DictReader(f)
    lookup = []
    for row in reader:
        sam = row["samaccountname"].strip()
        npi = row["npi"].strip()
        if sam:
            lookup.append({"samaccountname": sam, "npi": npi})

with open(OUTPUT_JSON, "w", encoding="utf-8") as f:
    json.dump(lookup, f)

print(f"Wrote {len(lookup)} entries to {OUTPUT_JSON}")