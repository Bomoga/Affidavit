// Test file for rules/semgrep/injection-sql-concat.yaml. Not executed; only parsed by Semgrep.
function cases(db, pool, req, userId, cache) {
  // ruleid: affidavit.injection.sql-concat
  db.query(`SELECT * FROM users WHERE name = '${req.body.name}'`);

  // ruleid: affidavit.injection.sql-concat
  db.query("SELECT * FROM users WHERE name = '" + userId + "'");

  // ruleid: affidavit.injection.sql-concat
  db.execute('SELECT * FROM t WHERE id = ' + userId + ' ORDER BY id');

  // ruleid: affidavit.injection.sql-concat
  db.raw(`DELETE FROM t WHERE id = ${userId}`);

  // ruleid: affidavit.injection.sql-concat
  knex('t').whereRaw('name = ' + userId);

  // Two or more concatenations.
  // ruleid: affidavit.injection.sql-concat
  db.query('SELECT * FROM t WHERE a = ' + userId + ' AND b = ' + req.body.b);

  // ruleid: affidavit.injection.sql-concat
  db.query('SELECT * FROM t WHERE a = ' + userId + ' ORDER BY id');

  // A bare call, for example a destructured query function.
  // ruleid: affidavit.injection.sql-concat
  query(`SELECT * FROM t WHERE id = ${userId}`);

  // Option objects.
  // ruleid: affidavit.injection.sql-concat
  db.query({ sql: `SELECT * FROM t WHERE id = ${userId}` });

  // ruleid: affidavit.injection.sql-concat
  pool.query({ text: 'SELECT * FROM t WHERE id = ' + userId, values: [] });

  // ok: affidavit.injection.sql-concat
  pool.query({ text: 'SELECT * FROM t WHERE id = $1', values: [userId] });

  // ok: affidavit.injection.sql-concat
  query('SELECT * FROM t WHERE id = $1', [userId]);

  // ok: affidavit.injection.sql-concat
  db.query('SELECT * FROM t ' + 'WHERE id = $1 ' + 'ORDER BY id', [userId]);

  // Semgrep's constant propagation sees that this variable is a string literal.
  const fixed = 'constant';
  // ok: affidavit.injection.sql-concat
  db.query(`SELECT * FROM users WHERE name = '${fixed}'`);

  // ok: affidavit.injection.sql-concat
  db.query('SELECT * FROM users WHERE name = $1', [userId]);

  // ok: affidavit.injection.sql-concat
  db.query('SELECT * FROM users WHERE ' + 'name = $1', [userId]);

  // ok: affidavit.injection.sql-concat
  db.query(`SELECT * FROM users WHERE id = ${parseInt(userId, 10)}`);

  const n = Number(userId);
  // ok: affidavit.injection.sql-concat
  db.query(`SELECT * FROM users WHERE id = ${n}`);

  // ok: affidavit.injection.sql-concat
  const rows = cache.get('key' + userId);
}
