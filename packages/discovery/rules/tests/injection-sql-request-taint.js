// Test file for rules/semgrep/injection-sql-request-taint.yaml. Not executed; only parsed by Semgrep.
function cases(db, connection, pool, knex, req, res) {
  // ruleid: affidavit.injection.sql-request-taint
  db.query(`SELECT * FROM users WHERE name = '${req.body.name}'`);

  const q = req.query.q;
  // ruleid: affidavit.injection.sql-request-taint
  db.query("SELECT * FROM t WHERE c = '" + q + "'");

  // Built into a variable first, then queried.
  const sql = "SELECT * FROM users WHERE name = '" + req.query.name + "'";
  // ruleid: affidavit.injection.sql-request-taint
  connection.query(sql);

  const stmt = `SELECT * FROM orders WHERE id = ${req.params.id}`;
  // ruleid: affidavit.injection.sql-request-taint
  pool.query(stmt, (err, rows) => res.json(rows));

  // ruleid: affidavit.injection.sql-request-taint
  knex('users').whereRaw("name = '" + req.body.name + "'");

  // ruleid: affidavit.injection.sql-request-taint
  knex('users').orderByRaw(req.query.sort);

  const having = `count(*) > ${req.query.n}`;
  // ruleid: affidavit.injection.sql-request-taint
  knex('users').havingRaw(having);

  // ruleid: affidavit.injection.sql-request-taint
  knex('users').joinRaw(`join t on t.id = ${req.body.id}`);

  // ok: affidavit.injection.sql-request-taint
  db.query(`SELECT * FROM users WHERE id = ${parseInt(req.params.id, 10)}`);

  // ok: affidavit.injection.sql-request-taint
  db.query('SELECT * FROM users WHERE name = $1', [req.body.name]);

  // ok: affidavit.injection.sql-request-taint
  knex('users').whereRaw('name = ?', [req.body.name]);

  const fixed = 'constant';
  // ok: affidavit.injection.sql-request-taint
  db.query(`SELECT * FROM users WHERE name = '${fixed}'`);

  const userId = 7;
  // ok: affidavit.injection.sql-request-taint
  db.query('SELECT * FROM users WHERE id = ' + userId);

  const n = Number(req.query.n);
  const safe = `SELECT * FROM t LIMIT ${n}`;
  // ok: affidavit.injection.sql-request-taint
  db.query(safe);
}
