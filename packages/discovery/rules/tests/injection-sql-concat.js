// Test file for rules/semgrep/injection-sql-concat.yaml. Not executed; only parsed by Semgrep.
function cases(db, req, userId, cache) {
  // ruleid: affidavit.injection.sql-concat
  db.query(`SELECT * FROM users WHERE name = '${req.body.name}'`);

  // ruleid: affidavit.injection.sql-concat
  db.query("SELECT * FROM users WHERE name = '" + userId + "'");

  // ruleid: affidavit.injection.sql-concat
  db.execute('SELECT * FROM t WHERE id = ' + userId + ' ORDER BY id');

  // ruleid: affidavit.injection.sql-concat
  db.raw(`DELETE FROM t WHERE id = ${userId}`);

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
