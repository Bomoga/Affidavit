// Test file for rules/semgrep/idor-route-param.yaml. Not executed; only parsed by Semgrep.
// The finding is on the statement that reads the identifier from the request, or on the call
// when the identifier is used inline.
function handlers(db, accountDAO, Order, prisma, Joi, next) {
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

  this.byParamLet = (req, res, next) => {
    // ruleid: affidavit.idor.route-param-to-data-access
    let orderId = req.params.orderId;
    return Order.findById(orderId);
  };

  this.byParamVar = (req, res, next) => {
    // ruleid: affidavit.idor.route-param-to-data-access
    var { orderId } = req.params;
    return Order.findById(orderId);
  };

  this.byParamNested = (req, res, next) => {
    // ruleid: affidavit.idor.route-param-to-data-access
    const { id } = req.params;
    db.collection('orders').findOne({ _id: id });
  };

  this.inlineModel = (req, res, next) => {
    // ruleid: affidavit.idor.route-param-to-data-access
    Order.findById(req.params.id).then((o) => res.json(o));
  };

  this.inlineDottedReceiver = async (req, res, next) => {
    // ruleid: affidavit.idor.route-param-to-data-access
    const order = await prisma.order.findUnique({ where: { id: req.params.id } });
    res.json(order);
  };

  this.inlineThisRepo = (req, res, next) => {
    // ruleid: affidavit.idor.route-param-to-data-access
    return this.orderRepo.findOne(req.params.id);
  };

  this.guardDoesNothing = (req, res, next) => {
    // A guard that only logs does not stop the request, so it does not count.
    // ruleid: affidavit.idor.route-param-to-data-access
    const { userId } = req.params;
    if (userId !== req.session.userId) {
      console.log('mismatch');
    }
    return accountDAO.getByUserId(userId, (err, rows) => res.json(rows));
  };

  this.guardOutsideCall = (req, res, next) => {
    // A positive guard that does not wrap the call does not count either.
    // ruleid: affidavit.idor.route-param-to-data-access
    const { userId } = req.params;
    if (userId === req.session.userId) {
      console.log('same user');
    }
    return accountDAO.getByUserId(userId, (err, rows) => res.json(rows));
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

  this.guardedByThrow = (req, res, next) => {
    // ok: affidavit.idor.route-param-to-data-access
    const { userId } = req.params;
    if (userId != req.session.userId) {
      throw new Error('forbidden');
    }
    return accountDAO.getByUserId(userId, (err, rows) => res.json(rows));
  };

  this.guardedByNext = (req, res, next) => {
    // ok: affidavit.idor.route-param-to-data-access
    const { userId } = req.params;
    if (req.session.userId !== userId) {
      next(new Error('forbidden'));
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

  this.inlineGuarded = (req, res, next) => {
    if (req.params.id !== req.session.userId) {
      return res.sendStatus(403);
    }
    // ok: affidavit.idor.route-param-to-data-access
    return Order.findById(req.params.id);
  };

  this.inlineGuardWraps = (req, res, next) => {
    if (req.params.id === req.session.userId) {
      // ok: affidavit.idor.route-param-to-data-access
      return Order.findById(req.params.id);
    }
    return res.sendStatus(403);
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

  this.validatorIsNotDataAccess = (req, res, next) => {
    // ok: affidavit.idor.route-param-to-data-access
    const { id } = req.params;
    const { error } = Joi.string().validate(id);
    res.json({ error });
  };

  this.validatorInline = (req, res, next) => {
    // ok: affidavit.idor.route-param-to-data-access
    const { error } = Joi.string().validate(req.params.id);
    res.json({ error });
  };
}
