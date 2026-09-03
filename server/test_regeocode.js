'use strict';
/* The rules for the second geocoding pass. No database, no network, no cost.
 *
 * The rules matter more than the geocoding. A second opinion that is merely more
 * CONFIDENT is not a reason to move a customer's pin: Google grading its own answer is
 * exactly the signal that failed on Hot Fill, where it was ROOFTOP-sure and 23 km into
 * the wrong town.
 */
const { decide, pickCandidate, buildTowns, kmApart, townKey, inTown, RANK, rankOf,
        NOT_A_TOWN, QUERIES, AGREE_KM } = require('./regeocode');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  ->  ' + JSON.stringify(extra) : '')); }
};

/* A town of four stores within a few hundred metres, so its bar is the 8 km floor. */
const rows = [
  { lat: 6.15, lng: -75.38, city: 'Rionegro' },
  { lat: 6.151, lng: -75.381, city: 'Rionegro' },
  { lat: 6.152, lng: -75.379, city: 'Rionegro' },
  { lat: 6.149, lng: -75.382, city: 'Rionegro' },
  { lat: 6.15, lng: -75.38, city: 'No identificada' },
  { lat: 9.99, lng: -70.00, city: 'No identificada' },
  { lat: 6.15, lng: -75.38, city: 'No identificada' },
  { lat: 1.00, lng: -70.00, city: 'No identificada' },
];
const towns = buildTowns(rows);
const rio = towns.get('rionegro');

ok('a town of four anchors a reference point', Boolean(rio), [...towns.keys()]);
// Left in, these form one cloud whose centre is nowhere, and then every store in it
// looks wrong - including the ones that are perfectly placed.
ok('a city column that is not a city is never a reference',
   !towns.has('no identificada'), [...towns.keys()]);
ok('a tight town still gets the 8 km floor, not a 200 m hair trigger',
   rio.far === 8, rio);

const MEDELLIN = { lat: 6.2387, lng: -75.5648 };      // 23 km from Rionegro
const before = { lat: 6.15, lng: -75.38, precision: 'APPROXIMATE' };

/* ---------------------------------------------------------------- decide() ---- */

ok('a more precise answer nearby is taken',
   decide({ before, after: { ...MEDELLIN, lat: 6.153, lng: -75.383, precision: 'ROOFTOP' }, town: rio }).take);

// The Hot Fill failure as a rule: Google was MORE sure, and out of town.
const far = decide({ before, after: { ...MEDELLIN, precision: 'ROOFTOP' }, town: rio });
ok('a more precise answer OUTSIDE the town is refused', !far.take, far);
ok('...and says how far outside, rather than just "rejected"', /\d/.test(far.why), far);

/* THE ONE THAT MATTERS MOST. The pin we hold is ROOFTOP in Medellin; the new answer is
   a mere GEOMETRIC_CENTER, but it is in Rionegro where this customer's other stores
   are. Ranking by Google's confidence keeps the wrong pin. */
const rescue = decide({
  before: { ...MEDELLIN, precision: 'ROOFTOP' },
  after: { lat: 6.151, lng: -75.381, precision: 'GEOMETRIC_CENTER' },
  town: rio,
});
ok('a LOWER-graded answer wins when it is in the right town and the old one was not',
   rescue.take && rescue.rescue === true, rescue);
ok('...and the reason says it was out of town, not that it got more precise',
   /out of town/.test(rescue.why), rescue);

/* Control positive: with no town to check against, that same pair is refused as a
   downgrade. Proves it is the TOWN evidence doing the work, not the grades. */
const noTownPair = decide({
  before: { ...MEDELLIN, precision: 'ROOFTOP' },
  after: { lat: 6.151, lng: -75.381, precision: 'GEOMETRIC_CENTER' },
  town: null,
});
ok('control positive: without the town evidence the same pair is refused',
   !noTownPair.take, noTownPair);

const worse = decide({ before, after: { lat: 6.151, lng: -75.381, precision: 'APPROXIMATE' }, town: rio });
ok('an answer no better than the one we have does not move an in-town pin', !worse.take, worse);

ok('a downgrade between two in-town answers is refused',
   !decide({ before: { ...before, precision: 'ROOFTOP' },
             after: { lat: 6.151, lng: -75.381, precision: 'APPROXIMATE' }, town: rio }).take);

ok('no answer at all leaves the pin alone', !decide({ before, after: null, town: rio }).take);

ok('a store in an unknown town can still be improved, IF both questions agree',
   decide({ before, after: { lat: 6.16, lng: -75.39, precision: 'ROOFTOP', agrees: true },
            town: null }).take);

/* The ca_id=3655 shape, from the real run. City "No identificada", address "Clle 14,
   Colombia", and one confident-sounding answer 742 km away in Santa Marta. With no
   town to check against, a precision bump is Google grading its own homework. */
const lone = decide({
  before: { lat: 4.57087, lng: -74.29733, precision: 'APPROXIMATE' },
  after: { lat: 11.2409, lng: -74.18347, precision: 'GEOMETRIC_CENTER', agrees: false },
  town: null,
});
ok('with no town AND no second opinion, a lone confident answer is refused',
   !lone.take, lone);
ok('...and says so, rather than blaming precision', /only one question/.test(lone.why), lone);

/* Control positive: the SAME move, with a town reference that accepts it, is taken.
   Without this, the assertion above would also pass if decide() had simply stopped
   accepting anything at all. */
const rioTown = { lat: 11.24, lng: -74.183, far: 8 };
ok('control positive: the identical move IS taken when a town vouches for it',
   decide({ before: { lat: 11.30, lng: -74.19, precision: 'APPROXIMATE' },
            after: { lat: 11.2409, lng: -74.18347, precision: 'GEOMETRIC_CENTER', agrees: false },
            town: rioTown }).take);

// An unknown precision string must not outrank a known one by accident.
ok('an unrecognised precision ranks below everything, it does not win by default',
   rankOf('SOMETHING_NEW') < RANK.APPROXIMATE, rankOf('SOMETHING_NEW'));

/* ----------------------------------------------------------- pickCandidate() ---- */

/* The exact Hot Fill response: Google's FIRST answer is Medellin and its SECOND is
   Rionegro. Reading results[0] is what put the pin in the wrong town. */
const hotfill = [
  { ...MEDELLIN, precision: 'ROOFTOP', tag: 'addr' },
  { lat: 6.1508, lng: -75.3800, precision: 'GEOMETRIC_CENTER', tag: 'addr' },
];
const picked = pickCandidate({ pool: hotfill, town: rio });
ok('the in-town candidate is chosen over Google\'s own first answer',
   picked.lat === 6.1508, picked);
ok('...even though the rejected one is graded higher',
   rankOf(hotfill[0].precision) > rankOf(picked.precision));

/* Control positive: same list, no town evidence -> Google's order stands. If this ever
   returned Rionegro too, the test above would be proving nothing. */
ok('control positive: with no town, Google\'s first answer is kept',
   pickCandidate({ pool: hotfill, town: null }).lat === MEDELLIN.lat);

// Two different questions landing in the same spot is corroboration; one confident
// answer standing alone is not.
const corroborated = pickCandidate({ pool: [
  { lat: 6.1600, lng: -75.3900, precision: 'ROOFTOP', tag: 'addr' },
  { lat: 6.1510, lng: -75.3810, precision: 'GEOMETRIC_CENTER', tag: 'addr' },
  { lat: 6.1511, lng: -75.3811, precision: 'GEOMETRIC_CENTER', tag: 'name+addr' },
], town: rio });
ok('an answer both questions agree on beats a higher-graded lone one',
   Math.abs(corroborated.lat - 6.151) < 0.001, corroborated);

// ...but agreement must come from the OTHER question. Two results of the SAME query
// sitting near each other is one opinion, not two.
const selfAgree = pickCandidate({ pool: [
  { lat: 6.1510, lng: -75.3810, precision: 'GEOMETRIC_CENTER', tag: 'addr' },
  { lat: 6.1511, lng: -75.3811, precision: 'GEOMETRIC_CENTER', tag: 'addr' },
  { lat: 6.1600, lng: -75.3900, precision: 'ROOFTOP', tag: 'addr' },
], town: rio });
ok('two answers to the SAME question do not corroborate each other',
   selfAgree.precision === 'ROOFTOP', selfAgree);

ok('an empty pool picks nothing rather than throwing',
   pickCandidate({ pool: [], town: rio }) === null);

ok('both questions are asked, and one of them carries the store name',
   QUERIES.length === 2 && QUERIES.some(q => /name/.test(q.tag)),
   QUERIES.map(q => q.tag));
ok('the two questions really differ on a real row',
   QUERIES[0].build({ name: 'Hot Fill S.A.S', addr: 'KM 1 VIA LAS PALMAS, Rionegro' })
   !== QUERIES[1].build({ name: 'Hot Fill S.A.S', addr: 'KM 1 VIA LAS PALMAS, Rionegro' }));

/* ------------------------------------------------------------------ maths ---- */

ok('distance maths is sane (Rionegro to Medellin is about 23 km)',
   Math.abs(kmApart({ lat: 6.15, lng: -75.38 }, MEDELLIN) - 23) < 3,
   kmApart({ lat: 6.15, lng: -75.38 }, MEDELLIN));

ok('town names normalise past accents and codes',
   townKey('Medellín') === 'medellin' && townKey('41-001 - Neiva') === 'neiva'
   && townKey('Bogota D.C.') === 'bogota',
   [townKey('Medellín'), townKey('41-001 - Neiva'), townKey('Bogota D.C.')]);

ok('ROOFTOP outranks every other grade',
   RANK.ROOFTOP > RANK.RANGE_INTERPOLATED && RANK.RANGE_INTERPOLATED > RANK.GEOMETRIC_CENTER
   && RANK.GEOMETRIC_CENTER > RANK.APPROXIMATE);

ok('a store with no town reference counts as in town, not as out of it',
   inTown({ lat: 0, lng: 0 }, undefined) === true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
