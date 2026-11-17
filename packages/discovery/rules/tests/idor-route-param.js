// Test file for rules/semgrep/idor-route-param.yaml. Not executed; only parsed by Semgrep.
// Where the finding goes: on the request expression of the statement that reads the identifier
// (req.params), or on the call when the identifier is used inline.
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

  this.guardAfterTheCall = async (req, res, next) => {
    // The check comes too late: the record is already gone.
    // ruleid: affidavit.idor.route-param-to-data-access
    const id = req.params.id;
    await Order.findByIdAndDelete(id);
    if (id !== req.session.userId) {
      return res.sendStatus(403);
    }
    res.end();
  };

  this.guardedCallDoesNotClearOthers = (req, res, next) => {
    // The first call is inside the guard; the second is not, so the read is still reported.
    // ruleid: affidavit.idor.route-param-to-data-access
    const { id } = req.params;
    if (id === req.session.userId) {
      Order.findById(id);
    }
    accountDAO.remove(id);
  };

  this.bareNextDoesNotStop = (req, res, next) => {
    // next(err) without return lets the handler carry on to the data call.
    // ruleid: affidavit.idor.route-param-to-data-access
    const { userId } = req.params;
    if (req.session.userId !== userId) {
      next(new Error('forbidden'));
    }
    return accountDAO.getByUserId(userId, (err, rows) => res.json(rows));
  };

  this.elseBranchIsNotGuarded = (req, res, next) => {
    // The call sits in the else-branch, where the ids differ.
    // ruleid: affidavit.idor.route-param-to-data-access
    const { id } = req.params;
    if (id === req.session.userId) {
      res.end();
    } else {
      Order.findById(id);
    }
  };

  this.csrfTokenIsNotOwnership = (req, res, next) => {
    // Comparing with a session field that is not an id is not an ownership check.
    // ruleid: affidavit.idor.route-param-to-data-access
    const { id } = req.params;
    if (id !== req.session.csrfToken) {
      return res.sendStatus(403);
    }
    return Order.findById(id);
  };

  this.inlineGuardAfterCall = async (req, res, next) => {
    // ruleid: affidavit.idor.route-param-to-data-access
    await Order.findById(req.params.id);
    if (req.params.id !== req.session.userId) {
      return res.sendStatus(403);
    }
  };

  this.inlineElseBranch = (req, res, next) => {
    if (req.params.id === req.session.userId) {
      return res.end();
    } else {
      // ruleid: affidavit.idor.route-param-to-data-access
      return Order.findById(req.params.id);
    }
  };

  this.inlineBareNext = (req, res, next) => {
    if (req.params.id !== req.session.userId) {
      next(new Error('forbidden'));
    }
    // ruleid: affidavit.idor.route-param-to-data-access
    return Order.findById(req.params.id);
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

  this.guardedBracelessReturn = (req, res, next) => {
    // ok: affidavit.idor.route-param-to-data-access
    const { userId } = req.params;
    if (userId !== req.session.userId) return res.sendStatus(403);
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

  this.guardedByReturnNext = (req, res, next) => {
    // ok: affidavit.idor.route-param-to-data-access
    const { userId } = req.params;
    if (req.session.userId !== userId) {
      return next(new Error('forbidden'));
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

  this.koaGuard = async (ctx) => {
    // ok: affidavit.idor.route-param-to-data-access
    const { id } = ctx.params;
    if (id !== ctx.state.user.id) {
      ctx.throw(403);
    }
    ctx.body = await Order.findById(id);
  };

  this.koaGuardBraceless = async (ctx) => {
    // ok: affidavit.idor.route-param-to-data-access
    const { id } = ctx.params;
    if (id !== ctx.state.user.id) ctx.throw(403);
    ctx.body = await Order.findById(id);
  };

  this.koaUnguarded = async (ctx) => {
    // ruleid: affidavit.idor.route-param-to-data-access
    const { id } = ctx.params;
    ctx.body = await Order.findById(id);
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
