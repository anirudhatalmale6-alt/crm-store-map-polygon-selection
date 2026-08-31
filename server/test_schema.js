'use strict';
/* schema.js: the file you edit to match your CRM's table and column names.
 *
 * Table and column names cannot be passed as query parameters, so they are
 * concatenated into SQL. That makes the validation here the only thing standing
 * between a config mistake and a broken - or hostile - query.
 */
const { makeSchema, ident, DEFAULTS } = require('./schema');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ->  ' + JSON.stringify(extra) : '')); }
};
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

console.log('defaults');
const s = makeSchema();
ok('table is quoted with backticks', s.table === '`stores`', s.table);
ok('every configured name appears in the select list',
   ['`id`', '`name`', '`category`', '`latitude`', '`longitude`', '`address`',
    '`location_source`', '`location_precision`'].every(c => s.selectCols.includes(c)),
   s.selectCols);
// The rest of the code reads r.lat / r.lng / r.location_source, so the aliases are
// part of the contract - rename one and every route breaks quietly.
ok('columns are aliased to the fixed names the code reads',
   s.selectCols.includes('AS lat') && s.selectCols.includes('AS lng') &&
   s.selectCols.includes('AS location_source') && s.selectCols.includes('AS location_precision'),
   s.selectCols);

console.log('\noverrides');
const t = makeSchema({ table: 'tiendas', category: 'categoria', latitude: 'lat' }, {});
ok('an overridden table name is used', t.table === '`tiendas`', t.table);
ok('an overridden column is aliased back to the fixed name',
   t.selectCols.includes('`categoria` AS category'), t.selectCols);
ok('un-overridden columns keep their defaults', t.selectCols.includes('`longitude` AS lng'), t.selectCols);
// Control positive: without this, a makeSchema that ignored overrides entirely
// would pass the two assertions above if the defaults happened to match.
ok('control positive: the override really changed something',
   t.table !== s.table && t.selectCols !== s.selectCols);

console.log('\nenvironment variables');
const e = makeSchema({}, { STORES_TABLE: 'shops', STORES_CATEGORY_COL: 'kind' });
ok('STORES_TABLE is picked up', e.table === '`shops`', e.table);
ok('STORES_CATEGORY_COL is picked up', e.selectCols.includes('`kind` AS category'), e.selectCols);
const both = makeSchema({ table: 'from_arg' }, { STORES_TABLE: 'from_env' });
ok('env wins over the argument', both.table === '`from_env`', both.table);
ok('an empty env var does not blank out a name',
   makeSchema({}, { STORES_TABLE: '' }).table === '`stores`');

console.log('\nrejecting anything that is not a plain identifier');
const BAD = [
  ['stores`; DROP TABLE users; --', 'a backtick escape'],
  ['stores; DROP TABLE users',      'a statement separator'],
  ['stores stores',                 'a space'],
  ['stores-1',                      'a hyphen'],
  ['db.stores',                     'a qualified name'],
  ['1stores',                       'a leading digit'],
  ['',                              'an empty string'],
  ['x'.repeat(65),                  'over 64 characters'],
  ['sto res',                       'an internal space'],
  ["stores'",                       'a quote'],
];
for (const [value, why] of BAD) {
  ok(`rejects ${why}`, throws(() => makeSchema({ table: value }, {})), value);
}
ok('rejects a non-string', throws(() => makeSchema({ table: 123 }, {})));
ok('rejects null', throws(() => ident(null, 'table')));

// If validation only ran on the table, a poisoned column name would sail through.
ok('validates COLUMN names too, not just the table',
   throws(() => makeSchema({ category: 'cat`, (SELECT 1) AS x, `id' }, {})));

console.log('\naccepting the names real CRMs actually use');
for (const good of ['stores', 'tiendas', 'Store', 'store_locations', 'tbl_stores2', '_stores', 'a$b']) {
  ok(`accepts ${good}`, !throws(() => makeSchema({ table: good }, {})));
}
// Control positive: a validator that accepted everything would also pass the
// "accepts" block above. The BAD list is what makes this suite mean anything.
ok('control positive: the validator is not a no-op',
   throws(() => makeSchema({ table: 'a b' }, {})) && !throws(() => makeSchema({ table: 'ab' }, {})));

ok('DEFAULTS lists every name the routes need',
   ['table', 'id', 'name', 'category', 'address', 'latitude', 'longitude',
    'geocodedAt', 'source', 'precision'].every(k => k in DEFAULTS), Object.keys(DEFAULTS));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
