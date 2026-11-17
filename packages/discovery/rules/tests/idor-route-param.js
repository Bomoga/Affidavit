// Test file for rules/semgrep/idor-route-param.yaml. Not executed; only parsed by Semgrep.
// The finding is on the statement that reads the identifier from the request.
function handlers(db, accountDAO, Order) {
  this.byParamDestructured = (req, res, next) => {
    // ruleid: affidavit.idor.route-param-to-data-access
    const { userId } = req.params;
    accountDAO.getByUserId(userId, (err, rows) => res.json(rows));
  };

  this.byParamVariable = (req, res, next) => {
    // ruleid: affidavit.idor.route-param-to-data-access
    const orderId = req.params.orderId;
    return Order.findById(orderId).then((o) => res.json(o));
  };

  this.byParamNested = (req, res, next) => {
    // ruleid: affidavit.idor.route-param-to-data-access
    const { id } = req.params;
    db.collection('orders').findOne({ _id: id });
  };

  this.guardedByEquality = (req, res, next) => {
    // ok: affidavit.idor.route-param-to-data-access
    const { userId } = req.params;
    if (userId === req.session.userId) {
      return accountDAO.getByUserId(userId, (err, rows) => res.json(rows));
    }
    return res.sendStatus(403);
  };

  this.guardedByEarlyReturn = (req, res, next) => {
    // ok: affidavit.idor.route-param-to-data-access
    const { userId } = req.params;
    if (userId !== req.session.userId) {
      return res.sendStatus(403);
    }
    return accountDAO.getByUserId(userId, (err, rows) => res.json(rows));
  };

  this.guardedByUser = (req, res, next) => {
    // ok: affidavit.idor.route-param-to-data-access
    const orderId = req.params.orderId;
    if (req.user.id != orderId) {
      return res.sendStatus(403);
    }
    return Order.findById(orderId);
  };

  this.ownerFromSession = (req, res, next) => {
    // ok: affidavit.idor.route-param-to-data-access
    const { userId } = req.session;
    accountDAO.getByUserId(userId, (err, rows) => res.json(rows));
  };

  this.notDataAccess = (req, res, next) => {
    // ok: affidavit.idor.route-param-to-data-access
    const { id } = req.params;
    res.render('page', { id });
  };
}
