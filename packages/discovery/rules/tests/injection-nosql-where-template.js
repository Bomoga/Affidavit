// Test file for rules/semgrep/injection-nosql-where-template.yaml. Not executed; only parsed by Semgrep.
const HIGH = 50;

function cases(col, Model, userId, threshold, name) {
  const parsedUserId = parseInt(userId);

  // ruleid: affidavit.injection.nosql-where-template
  col.find({ $where: `this.userId == ${parsedUserId} && this.stocks > '${threshold}'` });

  // ruleid: affidavit.injection.nosql-where-template
  col.find({ $where: "this.name == '" + name + "'" });

  // ruleid: affidavit.injection.nosql-where-template
  col.find({ $where: name + ' == this.name' });

  // ruleid: affidavit.injection.nosql-where-template
  col.find({ $where: `this.name == '${name}'` });

  // A numeric coercion on one value does not excuse a raw value in the same expression.
  // ruleid: affidavit.injection.nosql-where-template
  col.find({ $where: `this.a == ${parseInt(userId, 10)} && this.b == '${name}'` });

  // Flagged on purpose: the rule is pattern-level and cannot tell a constant from request data
  // when the constant is a variable. The corpus negative control relies on this.
  // ruleid: affidavit.injection.nosql-where-template
  col.find({ $where: `this.stocks > ${HIGH}` });

  // ok: affidavit.injection.nosql-where-template
  col.find({
    $where: `this.userId == ${parsedUserId} && this.stocks > ${parseInt(threshold, 10)}`,
  });

  // ruleid: affidavit.injection.nosql-where-template
  Model.find().$where(`this.name == '${name}'`);

  // ruleid: affidavit.injection.nosql-where-template
  Model.find().$where("this.name == '" + name + "'");

  // ok: affidavit.injection.nosql-where-template
  Model.find().$where(`this.stocks > ${Number(threshold)}`);

  // ok: affidavit.injection.nosql-where-template
  col.find({ $where: `this.stocks > ${Number(threshold)}` });

  // ok: affidavit.injection.nosql-where-template
  col.find({ $where: 'this.stocks > ' + '50' });

  // ok: affidavit.injection.nosql-where-template
  col.find({ $where: `this.stocks > ${50}` });

  // ok: affidavit.injection.nosql-where-template
  col.find({ userId: parsedUserId });
}

function viaVariable(col, Model, name) {
  const expr = `this.name == '${name}'`;
  // ruleid: affidavit.injection.nosql-where-template
  col.find({ $where: expr });

  const joined = "this.name == '" + name + "'";
  // ruleid: affidavit.injection.nosql-where-template
  Model.find({ $where: joined });

  const safeExpr = `this.stocks > ${Number(name)}`;
  // ok: affidavit.injection.nosql-where-template
  col.find({ $where: safeExpr });

  const fixedExpr = 'this.active == true';
  // ok: affidavit.injection.nosql-where-template
  col.find({ $where: fixedExpr });
}
