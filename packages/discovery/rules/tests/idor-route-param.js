// Test file for rules/semgrep/idor-route-param.yaml. Not executed; only parsed by Semgrep.
// The finding is on the data-access call that uses the route parameter. Each call is judged on
// its own.
function handlers(db, accountDAO, Order, prisma, Joi, next) {
  this.byParamDestructured = (req, res, next) => {
    const { userId } = req.params;
    // ruleid: affidavit.idor.route-param-to-data-access
    accountDAO.getByUserId(userId, (err, rows) => res.json(rows));
  };

  this.byParamVariable = (req, res, next) => {
    const orderId = req.params.orderId;
    // ruleid: affidavit.idor.route-param-to-data-access
    return Order.findById(orderId).then((o) => res.json(o));
  };

  this.byParamLet = (req, res, next) => {
    let orderId = req.params.orderId;
    // ruleid: affidavit.idor.route-param-to-data-access
    return Order.findById(orderId);
  };

  this.byParamVar = (req, res, next) => {
    var { orderId } = req.params;
    // ruleid: affidavit.idor.route-param-to-data-access
    return Order.findById(orderId);
  };

  this.byParamNested = (req, res, next) => {
    const { id } = req.params;
    // ruleid: affidavit.idor.route-param-to-data-access
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
    const { userId } = req.params;
    if (userId !== req.session.userId) {
      console.log('mismatch');
    }
    // ruleid: affidavit.idor.route-param-to-data-access
    return accountDAO.getByUserId(userId, (err, rows) => res.json(rows));
  };

  this.guardOutsideCall = (req, res, next) => {
    // A positive guard that does not wrap the call does not count either.
    const { userId } = req.params;
    if (userId === req.session.userId) {
      console.log('same user');
    }
    // ruleid: affidavit.idor.route-param-to-data-access
    return accountDAO.getByUserId(userId, (err, rows) => res.json(rows));
  };

  this.guardAfterTheCall = async (req, res, next) => {
    // The check comes too late: the record is already gone.
    const id = req.params.id;
    // ruleid: affidavit.idor.route-param-to-data-access
    await Order.findByIdAndDelete(id);
    if (id !== req.session.userId) {
      return res.sendStatus(403);
    }
    res.end();
  };

  this.sameMethodTwice = async (req, res, next) => {
    // The first call comes before the guard, the second after it. Only the first is reported.
    const id = req.params.id;
    // ruleid: affidavit.idor.route-param-to-data-access
    await Order.findById(id);
    if (id !== req.session.userId) {
      return res.sendStatus(403);
    }
    // ok: affidavit.idor.route-param-to-data-access
    await Order.findById(id);
  };

  this.guardedCallDoesNotClearOthers = (req, res, next) => {
    // The first call is inside the guard; the second is not, so the second is reported.
    const { id } = req.params;
    if (id === req.session.userId) {
      // ok: affidavit.idor.route-param-to-data-access
      Order.findById(id);
    }
    // ruleid: affidavit.idor.route-param-to-data-access
    accountDAO.remove(id);
  };

  this.bareNextDoesNotStop = (req, res, next) => {
    // next(err) without return lets the handler carry on to the data call.
    const { userId } = req.params;
    if (req.session.userId !== userId) {
      next(new Error('forbidden'));
    }
    // ruleid: affidavit.idor.route-param-to-data-access
    return accountDAO.getByUserId(userId, (err, rows) => res.json(rows));
  };

  this.conditionalReturnInGuard = (req, res, next) => {
    // The guard only returns when a second condition holds, so it can fall through.
    const { id } = req.params;
    if (id !== req.session.userId) {
      if (req.query.strict) {
        return res.sendStatus(403);
      }
    }
    // ruleid: affidavit.idor.route-param-to-data-access
    return Order.findById(id);
  };

  this.returnInCatchInGuard = (req, res, next) => {
    const { id } = req.params;
    if (id !== req.session.userId) {
      try {
        audit(id);
      } catch (e) {
        return res.sendStatus(500);
      }
    }
    // ruleid: affidavit.idor.route-param-to-data-access
    return Order.findById(id);
  };

  this.returnInClosureInGuard = (req, res, next) => {
    // The return belongs to the callback, not to the handler.
    const { id } = req.params;
    if (id !== req.session.userId) {
      setTimeout(() => {
        return 1;
      });
    }
    // ruleid: affidavit.idor.route-param-to-data-access
    return Order.findById(id);
  };

  this.guardInUnrelatedIf = (req, res, next) => {
    // The guard only runs when strict is set; the call runs either way.
    const { id } = req.params;
    if (req.query.strict) {
      if (id !== req.session.userId) return res.sendStatus(403);
    }
    // ruleid: affidavit.idor.route-param-to-data-access
    return Order.findById(id);
  };

  this.guardInLoopBody = (req, res, next) => {
    const { id } = req.params;
    for (const x of req.query.list) {
      if (id !== req.session.userId) return res.sendStatus(403);
    }
    // ruleid: affidavit.idor.route-param-to-data-access
    return Order.findById(id);
  };

  this.guardInForEachCallback = (req, res, next) => {
    const { id } = req.params;
    req.query.list.forEach((x) => {
      if (id !== req.session.userId) return res.sendStatus(403);
    });
    // ruleid: affidavit.idor.route-param-to-data-access
    return Order.findById(id);
  };

  this.guardInFunctionNeverCalled = (req, res, next) => {
    const { id } = req.params;
    function check() {
      if (id !== req.session.userId) return res.sendStatus(403);
    }
    // ruleid: affidavit.idor.route-param-to-data-access
    return Order.findById(id);
  };

  this.elseBranchIsNotGuarded = (req, res, next) => {
    // The call sits in the else-branch, where the ids differ.
    const { id } = req.params;
    if (id === req.session.userId) {
      res.end();
    } else {
      // ruleid: affidavit.idor.route-param-to-data-access
      Order.findById(id);
    }
  };

  this.csrfTokenIsNotOwnership = (req, res, next) => {
    // Comparing with a session field that is not an id is not an ownership check.
    const { id } = req.params;
    if (id !== req.session.csrfToken) {
      return res.sendStatus(403);
    }
    // ruleid: affidavit.idor.route-param-to-data-access
    return Order.findById(id);
  };

  this.localNamedUserIsNotTheSignedInUser = (req, res, next) => {
    // body.user.id is request data, not the signed-in user.
    const body = req.body;
    const { id } = req.params;
    if (id !== body.user.id) {
      return res.sendStatus(403);
    }
    // ruleid: affidavit.idor.route-param-to-data-access
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

  this.koaUnguarded = async (ctx) => {
    const { id } = ctx.params;
    // ruleid: affidavit.idor.route-param-to-data-access
    ctx.body = await Order.findById(id);
  };

  this.guardedByEquality = (req, res, next) => {
    const { userId } = req.params;
    if (userId === req.session.userId) {
      // ok: affidavit.idor.route-param-to-data-access
      return accountDAO.getByUserId(userId, (err, rows) => res.json(rows));
    }
    return res.sendStatus(403);
  };

  this.guardedByEarlyReturn = (req, res, next) => {
    const { userId } = req.params;
    if (userId !== req.session.userId) {
      return res.sendStatus(403);
    }
    // ok: affidavit.idor.route-param-to-data-access
    return accountDAO.getByUserId(userId, (err, rows) => res.json(rows));
  };

  this.guardedBracelessReturn = (req, res, next) => {
    const { userId } = req.params;
    if (userId !== req.session.userId) return res.sendStatus(403);
    // ok: affidavit.idor.route-param-to-data-access
    return accountDAO.getByUserId(userId, (err, rows) => res.json(rows));
  };

  this.guardedTwoStatements = (req, res, next) => {
    const { userId } = req.params;
    if (userId !== req.session.userId) {
      audit(userId);
      return res.sendStatus(403);
    }
    // ok: affidavit.idor.route-param-to-data-access
    return accountDAO.getByUserId(userId, (err, rows) => res.json(rows));
  };

  this.guardedThreeStatements = (req, res, next) => {
    const { userId } = req.params;
    if (userId !== req.session.userId) {
      audit(userId);
      res.status(403);
      return res.end();
    }
    // ok: affidavit.idor.route-param-to-data-access
    return accountDAO.getByUserId(userId, (err, rows) => res.json(rows));
  };

  this.guardedByThrow = (req, res, next) => {
    const { userId } = req.params;
    if (userId != req.session.userId) {
      throw new Error('forbidden');
    }
    // ok: affidavit.idor.route-param-to-data-access
    return accountDAO.getByUserId(userId, (err, rows) => res.json(rows));
  };

  this.guardedByReturnNext = (req, res, next) => {
    const { userId } = req.params;
    if (req.session.userId !== userId) {
      return next(new Error('forbidden'));
    }
    // ok: affidavit.idor.route-param-to-data-access
    return accountDAO.getByUserId(userId, (err, rows) => res.json(rows));
  };

  this.guardedByUser = (req, res, next) => {
    const orderId = req.params.orderId;
    if (req.user.id != orderId) {
      return res.sendStatus(403);
    }
    // ok: affidavit.idor.route-param-to-data-access
    return Order.findById(orderId);
  };

  this.guardThenCallInsideAnIf = (req, res, next) => {
    // The guard is at the same level as the read; the call is nested later. Still protected.
    const { id } = req.params;
    if (id !== req.session.userId) return res.sendStatus(403);
    if (req.query.full) {
      // ok: affidavit.idor.route-param-to-data-access
      return Order.findById(id);
    }
  };

  this.koaGuard = async (ctx) => {
    const { id } = ctx.params;
    if (id !== ctx.state.user.id) {
      ctx.throw(403);
    }
    // ok: affidavit.idor.route-param-to-data-access
    ctx.body = await Order.findById(id);
  };

  this.koaGuardBraceless = async (ctx) => {
    const { id } = ctx.params;
    if (id !== ctx.state.user.id) ctx.throw(403);
    // ok: affidavit.idor.route-param-to-data-access
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
    const { userId } = req.session;
    // ok: affidavit.idor.route-param-to-data-access
    accountDAO.getByUserId(userId, (err, rows) => res.json(rows));
  };

  this.notDataAccess = (req, res, next) => {
    const { id } = req.params;
    // ok: affidavit.idor.route-param-to-data-access
    res.render('page', { id });
  };

  this.validatorIsNotDataAccess = (req, res, next) => {
    const { id } = req.params;
    // ok: affidavit.idor.route-param-to-data-access
    const { error } = Joi.string().validate(id);
    res.json({ error });
  };

  this.validatorInline = (req, res, next) => {
    // ok: affidavit.idor.route-param-to-data-access
    const { error } = Joi.string().validate(req.params.id);
    res.json({ error });
  };
}
