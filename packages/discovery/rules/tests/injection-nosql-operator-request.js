// Test file for rules/semgrep/injection-nosql-operator-request.yaml. Not executed; only parsed by Semgrep.
function cases(col, req, res) {
  // ruleid: affidavit.injection.nosql-operator-request
  col.findOne({ userName: req.body.userName, password: req.body.password });

  const filter = req.query;
  // ruleid: affidavit.injection.nosql-operator-request
  col.find(filter);

  // ok: affidavit.injection.nosql-operator-request
  col.findOne({ userName: String(req.body.userName) });

  // ok: affidavit.injection.nosql-operator-request
  col.findOne({ userId: parseInt(req.params.id, 10) });

  // ok: affidavit.injection.nosql-operator-request
  col.findOne({ userName: 'admin' });
}
