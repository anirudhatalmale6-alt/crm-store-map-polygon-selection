/* Unit tests for the polygon selection engine, run against the code that is
   actually shipped inside store-map-demo.html (extracted, not re-typed). */
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'store-map-demo.html'), 'utf8');
const start = html.indexOf('function pointInPolygon');
const end = html.indexOf('if (typeof module');
if (start < 0 || end < 0) throw new Error('could not extract engine from html');
const src = html.slice(start, end);
const { pointInPolygon, storesInPolygon, clusterPoints, clusterMix } =
  new Function(src + '\nreturn { pointInPolygon, storesInPolygon, clusterPoints, clusterMix };')();

let pass = 0, fail = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
};

// A square covering roughly central Madrid.
const square = [
  { lat: 40.410, lng: -3.720 },
  { lat: 40.410, lng: -3.690 },
  { lat: 40.440, lng: -3.690 },
  { lat: 40.440, lng: -3.720 },
];

console.log('point-in-polygon');
ok('point in the middle is inside',        pointInPolygon({ lat: 40.425, lng: -3.705 }, square) === true);
ok('point west of the square is outside',  pointInPolygon({ lat: 40.425, lng: -3.760 }, square) === false);
ok('point east of the square is outside',  pointInPolygon({ lat: 40.425, lng: -3.660 }, square) === false);
ok('point north of the square is outside', pointInPolygon({ lat: 40.470, lng: -3.705 }, square) === false);
ok('point south of the square is outside', pointInPolygon({ lat: 40.390, lng: -3.705 }, square) === false);
ok('empty polygon selects nothing',        pointInPolygon({ lat: 40.425, lng: -3.705 }, []) === false);
ok('2-vertex polygon selects nothing',     pointInPolygon({ lat: 40.425, lng: -3.705 }, square.slice(0, 2)) === false);

// Concave "C" shape: the notch must NOT be selected. A naive bounding-box
// implementation passes every test above and fails this one.
console.log('concave polygon');
const cShape = [
  { lat: 0, lng: 0 }, { lat: 0, lng: 10 }, { lat: 3, lng: 10 }, { lat: 3, lng: 3 },
  { lat: 7, lng: 3 }, { lat: 7, lng: 10 }, { lat: 10, lng: 10 }, { lat: 10, lng: 0 },
];
ok('point in the left bar is inside',      pointInPolygon({ lat: 5, lng: 1 }, cShape) === true);
ok('point in the notch is OUTSIDE',        pointInPolygon({ lat: 5, lng: 7 }, cShape) === false);
ok('point in the top arm is inside',       pointInPolygon({ lat: 1.5, lng: 7 }, cShape) === true);

console.log('storesInPolygon');
const stores = [
  { id: 1, name: 'in-1',  lat: 40.420, lng: -3.700 },
  { id: 2, name: 'in-2',  lat: 40.435, lng: -3.715 },
  { id: 3, name: 'out-1', lat: 40.500, lng: -3.700 },
  { id: 4, name: 'out-2', lat: 40.420, lng: -3.600 },
];
const hit = storesInPolygon(stores, square);
ok('selects exactly the two stores inside', hit.length === 2);
ok('selects the right ids',                 hit.map(s => s.id).join(',') === '1,2');
// Control positive: a polygon that covers everything must return all 4, so an
// empty result can never be mistaken for "the filter works".
const world = [{lat:-89,lng:-179},{lat:-89,lng:179},{lat:89,lng:179},{lat:89,lng:-179}];
ok('control positive: world polygon selects all 4', storesInPolygon(stores, world).length === 4);
ok('empty polygon selects none',                    storesInPolygon(stores, []).length === 0);

// ---------------------------------------------------------------------------
// Clustering. At 2,000 stores the map merges nearby pins into numbered bubbles.
// The dangerous failure is not an ugly map - it is a store silently vanishing,
// which looks identical to "it was never in the database". So the tests pin the
// conservation properties first: nothing lost, nothing duplicated.
console.log('\nclusterPoints');
const grid = [];
for (let i = 0; i < 500; i++) grid.push({ id: i, x: (i % 25) * 7, y: Math.floor(i / 25) * 7 });

const clustered = clusterPoints(grid, 40);
const seen = new Set();
let dupes = 0;
clustered.forEach(c => c.items.forEach(p => { if (seen.has(p.id)) dupes++; seen.add(p.id); }));
ok('every point lands in exactly one cluster', seen.size === 500 && dupes === 0);
ok('cluster counts sum to the input size',
   clustered.reduce((a, c) => a + c.count, 0) === 500);
ok('control positive: it really did group them', clustered.length < 500);
ok('count matches the items array', clustered.every(c => c.count === c.items.length));

const far = [{ id:1, x:0, y:0 }, { id:2, x:1000, y:1000 }];
ok('points far apart are not merged', clusterPoints(far, 40).length === 2);
const near = [{ id:1, x:10, y:10 }, { id:2, x:12, y:11 }];
ok('points in the same cell are merged', clusterPoints(near, 40).length === 1);
ok('a merged cluster sits between its members',
   (() => { const c = clusterPoints(near, 40)[0]; return c.x === 11 && c.y === 10.5; })());
ok('cellSize 0 disables clustering rather than dividing by zero',
   clusterPoints(grid, 0).length === 500);
ok('empty input gives no clusters', clusterPoints([], 40).length === 0);

// ---------------------------------------------------------------------------
// What a cluster is MADE of. This exists because a bubble holding two categories
// used to be painted one flat grey - the same grey as the Inactive category - so
// ticking a second category made active stores look inactive. Keeping the
// breakdown is what makes that impossible, so the breakdown gets tested.
console.log('\nclusterMix');
const CATS = [
  { id: 'active',    label: 'Active store',   color: '#3ddc97' },
  { id: 'potential', label: 'Potential',      color: '#ffb454' },
  { id: 'inactive',  label: 'Inactive store', color: '#8b97a6' },
];
const mixOf = cats => clusterMix(cats.map(c => ({ cat: c })), CATS);

const m1 = mixOf(['active', 'active', 'active']);
ok('a single-category cluster reports one category', m1.length === 1 && m1[0].count === 3);
ok('...whose share is the whole bubble', m1[0].frac === 1);

const m2 = mixOf(['active', 'active', 'active', 'potential']);
ok('a mixed cluster reports every category in it', m2.length === 2);
ok('...with the right counts', m2.map(m => m.id + ':' + m.count).join(',') === 'active:3,potential:1');
ok('...and shares that add up to exactly 1',
   Math.abs(m2.reduce((a, m) => a + m.frac, 0) - 1) < 1e-12);
// Conservation, same property the clustering tests pin: no store falls out of the
// breakdown, because a bubble that under-reports is a bubble drawn wrong.
ok('every store in the cluster is accounted for',
   m2.reduce((a, m) => a + m.count, 0) === 4);

// Order comes from CATEGORIES, not from the order stores happen to arrive in.
// Two bubbles with the same mix have to look the same, or the ring stops being
// something you can read across the map.
ok('the order is the category order, not the arrival order',
   mixOf(['potential', 'active']).map(m => m.id).join(',') === 'active,potential');
ok('a category with nobody in it is left out entirely',
   mixOf(['active']).some(m => m.id === 'inactive') === false);
ok('control positive: it does report inactive when there IS one',
   mixOf(['active', 'inactive']).some(m => m.id === 'inactive') === true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
