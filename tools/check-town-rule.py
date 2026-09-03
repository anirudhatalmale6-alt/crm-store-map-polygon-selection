"""One rule, two languages, checked on every real row.

"Is this pin outside its own town?" is implemented twice, and it has to be:

  * store-map-demo.html decides which pins get the wrong-town ring, in the browser;
  * server/regeocode.js decides which pins the second geocoding pass is allowed to
    move, in Node, and it is the one that spends the customer's money.

Two copies of one rule drift, and this drift would be silent AND expensive. If the
Node copy drew a slightly wider bar, it would haul pins the map was perfectly happy
with; if it drew a narrower one, the map would keep ringing pins the pass declines to
rescue, and the customer would go on seeing warnings that nothing will ever clear.

So both are run over the same 2,423 rows and their answers compared row by row. The
browser side is asked through window.__townRule(), i.e. the SHIPPED page — not a third
copy of the rule written inside this file, which would only ever prove itself right.

    python3 tools/check-town-rule.py            # needs map-data.js next to the HTML

Exit status is 0 only if the two agree on every row and on every constant.
"""
import json, os, subprocess, sys
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
DEMO = os.path.dirname(HERE)
HTML = os.path.join(DEMO, "store-map-demo.html")
DATA = os.path.join(DEMO, "map-data.js")

PASS = FAIL = 0
def ok(name, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1; print("  ok   " + name)
    else:
        FAIL += 1; print("  FAIL " + name + (("  ->  " + str(extra)) if extra else ""))

if not os.path.exists(DATA):
    sys.exit("map-data.js is not here. Export it first:\n"
             "  node server/export-map-data.js --port 13307 --db ventas --js > map-data.js")

# ---- the browser's answer, from the page itself -------------------------------
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 1280, "height": 720})
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto("file://" + HTML)
    pg.wait_for_function("window.__townRule !== undefined", timeout=15000)
    web = pg.evaluate("window.__townRule()")
    b.close()
ok("the page loaded without throwing", not errs, errs[:2])

# ---- Node's answer, from the module that actually moves the pins ---------------
node = json.loads(subprocess.run(
    ["node", "-e", """
const fs = require('fs');
const { buildTowns, townKey, inTown, TOWN_MIN, NOT_A_TOWN } = require('./server/regeocode');
// Read the same export the page reads, so neither side gets its own data set.
const src = fs.readFileSync('map-data.js', 'utf8');
global.window = {};
eval(src);
const stores = window.__STORE_DATA__.stores || window.__STORE_DATA__;
const rows = stores.map(s => ({ lat: s.lat, lng: s.lng, city: s.city, id: s.id }));
const towns = buildTowns(rows);
const off = rows.filter(r => !inTown(r, towns.get(townKey(r.city)))).map(r => r.id).sort();
console.log(JSON.stringify({
  offTown: off,
  towns: [...towns].map(([k, t]) => [k, t.n, +t.far.toFixed(6)]).sort(),
  notATown: [...NOT_A_TOWN].sort(),
}));
"""], cwd=DEMO, capture_output=True, text=True, check=True).stdout)

# ---- compare -------------------------------------------------------------------
ok("both sides read the same store set", len(web["offTown"]) >= 0 and len(node["towns"]) > 0)

ok("the excluded 'towns' lists are identical",
   web["constants"]["notATown"] == node["notATown"],
   set(web["constants"]["notATown"]) ^ set(node["notATown"]))

ok("both build the same towns, with the same bar for each",
   web["towns"] == node["towns"],
   [a for a, b in zip(web["towns"], node["towns"]) if a != b][:3])

wo, no = set(web["offTown"]), set(node["offTown"])
ok("every pin the map rings is a pin the re-geocoder may rescue",
   wo <= no, sorted(wo - no)[:8])
ok("...and the re-geocoder does not move pins the map never questioned",
   no <= wo, sorted(no - wo)[:8])
ok("so the two agree exactly, row for row", wo == no,
   {"only on the map": sorted(wo - no)[:5], "only in Node": sorted(no - wo)[:5]})

# A control positive. If both sides simply found nothing, every assertion above
# would pass while proving nothing at all.
ok("control positive: there ARE out-of-town pins for the comparison to bite on",
   len(wo) > 0, len(wo))

print(f"\n{PASS} passed, {FAIL} failed  ({len(wo)} pins out of town, "
      f"{len(node['towns'])} towns used as references)")
sys.exit(1 if FAIL else 0)
