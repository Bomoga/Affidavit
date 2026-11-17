// Test file for rules/semgrep/injection-nosql-operator-request.yaml. Not executed; only parsed by Semgrep.
function cases(col, Model, req, res) {
  // ruleid: affidavit.injection.nosql-operator-request
  col.findOne({ userName: req.body.userName, password: req.body.password });

  const filter = req.query;
  // ruleid: affidavit.injection.nosql-operator-request
  col.find(filter);

  // ruleid: affidavit.injection.nosql-operator-request
  col.updateOne({ _id: 1 }, req.body);

  // ruleid: affidavit.injection.nosql-operator-request
  col.updateMany({ ok: true }, { $set: req.body });

  // ruleid: affidavit.injection.nosql-operator-request
  col.replaceOne({ _id: 1 }, req.body);

  // ruleid: affidavit.injection.nosql-operator-request
  col.aggregate([{ $match: { owner: req.query.owner } }]);

  // ruleid: affidavit.injection.nosql-operator-request
  Model.findById(req.query.id);

  // ruleid: affidavit.injection.nosql-operator-request
  Model.findByIdAndDelete(req.query.id);

  // ruleid: affidavit.injection.nosql-operator-request
  Model.findByIdAndUpdate(req.query.id, { name: 'x' });

  // ruleid: affidavit.injection.nosql-operator-request
  Model.findOneAndRemove(req.body);

  // ruleid: affidavit.injection.nosql-operator-request
  col.count(req.query);

  // ruleid: affidavit.injection.nosql-operator-request
  Model.exists({ owner: req.body.owner });

  // ok: affidavit.injection.nosql-operator-request
  Model.exists({ owner: String(req.body.owner) });

  // Route parameters are always strings, so they are not a source for this rule.
  // ok: affidavit.injection.nosql-operator-request
  Model.findById(req.params.id);

  // ruleid: affidavit.injection.nosql-operator-request
  col.distinct('name', req.query);

  // ok: affidavit.injection.nosql-operator-request
  col.findOne({ userName: String(req.body.userName) });

  // ok: affidavit.injection.nosql-operator-request
  col.findOne({ userId: parseInt(req.params.id, 10) });

  // ok: affidavit.injection.nosql-operator-request
  col.findOne({ userName: 'admin' });

  // ok: affidavit.injection.nosql-operator-request
  col.updateOne({ _id: 1 }, { $set: { name: String(req.body.name) } });

  // ok: affidavit.injection.nosql-operator-request
  col.aggregate([{ $match: { owner: 'x' } }]);
}
