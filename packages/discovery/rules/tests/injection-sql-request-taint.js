// Test file for rules/semgrep/injection-sql-request-taint.yaml. Not executed; only parsed by Semgrep.
function cases(db, req, res) {
  // ruleid: affidavit.injection.sql-request-taint
  db.query(`SELECT * FROM users WHERE name = '${req.body.name}'`);

  const q = req.query.q;
  // ruleid: affidavit.injection.sql-request-taint
  db.query("SELECT * FROM t WHERE c = '" + q + "'");

  // ok: affidavit.injection.sql-request-taint
  db.query(`SELECT * FROM users WHERE id = ${parseInt(req.params.id, 10)}`);

  // ok: affidavit.injection.sql-request-taint
  db.query('SELECT * FROM users WHERE name = $1', [req.body.name]);

  const fixed = 'constant';
  // ok: affidavit.injection.sql-request-taint
  db.query(`SELECT * FROM users WHERE name = '${fixed}'`);

  const userId = 7;
  // ok: affidavit.injection.sql-request-taint
  db.query('SELECT * FROM users WHERE id = ' + userId);
}
