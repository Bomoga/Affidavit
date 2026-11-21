// Test file for rules/semgrep/idor-request-id.yaml. Not executed; only parsed by Semgrep.
// The finding is on the data-access call that uses the identifier.
function bodyIds(accountDAO, Order, prisma, Joi) {
  this.updateByBodyId = (req, res, next) => {
    const { userId, startDate } = req.body;
    // ruleid: affidavit.idor.request-id-to-data-access
    accountDAO.updateStart(userId, startDate, () => res.end());
  };

  this.queryId = (req, res, next) => {
    const orderId = req.query.orderId;
    // ruleid: affidavit.idor.request-id-to-data-access
    Order.findById(orderId);
  };

  this.letBinding = (req, res, next) => {
    let owner_id = req.body.owner_id;
    // ruleid: affidavit.idor.request-id-to-data-access
    Order.findById(owner_id);
  };

  this.inlineBody = (req, res, next) => {
    // ruleid: affidavit.idor.request-id-to-data-access
    Order.findById(req.body.orderId);
  };

  this.inlineDotted = async (req, res, next) => {
    // ruleid: affidavit.idor.request-id-to-data-access
    await prisma.order.update({ where: { id: req.query.id }, data: {} });
  };

  this.upperCaseId = (req, res, next) => {
    const orderID = req.body.orderID;
    // ruleid: affidavit.idor.request-id-to-data-access
    Order.findById(orderID);
  };

  this.guardAfterTheCall = async (req, res, next) => {
    const { userId } = req.body;
    // ruleid: affidavit.idor.request-id-to-data-access
    await accountDAO.remove(userId);
    if (userId !== req.user.id) {
      return res.sendStatus(403);
    }
  };

  this.sameMethodTwice = async (req, res, next) => {
    const { userId } = req.body;
    // ruleid: affidavit.idor.request-id-to-data-access
    await accountDAO.remove(userId);
    if (userId !== req.user.id) {
      return res.sendStatus(403);
    }
    // ok: affidavit.idor.request-id-to-data-access
    await accountDAO.remove(userId);
  };

  this.bareNextDoesNotStop = (req, res, next) => {
    const { userId } = req.body;
    if (userId !== req.user.id) {
      next(new Error('forbidden'));
    }
    // ruleid: affidavit.idor.request-id-to-data-access
    accountDAO.remove(userId);
  };

  this.conditionalReturnInGuard = (req, res, next) => {
    const { userId } = req.body;
    if (userId !== req.user.id) {
      if (req.query.strict) {
        return res.sendStatus(403);
      }
    }
    // ruleid: affidavit.idor.request-id-to-data-access
    accountDAO.remove(userId);
  };

  this.guardInUnrelatedIf = (req, res, next) => {
    const { userId } = req.body;
    if (req.query.strict) {
      if (userId !== req.user.id) return res.sendStatus(403);
    }
    // ruleid: affidavit.idor.request-id-to-data-access
    accountDAO.remove(userId);
  };

  this.csrfIsNotOwnership = (req, res, next) => {
    const { userId } = req.body;
    if (userId !== req.session.csrfToken) {
      return res.sendStatus(403);
    }
    // ruleid: affidavit.idor.request-id-to-data-access
    accountDAO.remove(userId);
  };

  this.localNamedUserIsNotTheSignedInUser = (req, res, next) => {
    const { userId } = req.body;
    const payload = req.body;
    if (userId !== payload.user.id) {
      return res.sendStatus(403);
    }
    // ruleid: affidavit.idor.request-id-to-data-access
    accountDAO.remove(userId);
  };

  this.inlineElseBranch = (req, res, next) => {
    if (req.body.userId === req.user.id) {
      return res.end();
    } else {
      // ruleid: affidavit.idor.request-id-to-data-access
      return accountDAO.remove(req.body.userId);
    }
  };

  this.guardedBraceless = (req, res, next) => {
    const { userId } = req.body;
    if (userId !== req.user.id) return res.sendStatus(403);
    // ok: affidavit.idor.request-id-to-data-access
    accountDAO.remove(userId);
  };

  this.guardedReturnNext = (req, res, next) => {
    const { userId } = req.body;
    if (userId !== req.user.id) return next(new Error('forbidden'));
    // ok: affidavit.idor.request-id-to-data-access
    accountDAO.remove(userId);
  };

  this.guarded = (req, res, next) => {
    const { userId } = req.body;
    if (userId != req.user.id) {
      return res.sendStatus(403);
    }
    // ok: affidavit.idor.request-id-to-data-access
    accountDAO.updateStart(userId, 1, () => res.end());
  };

  this.guardDoesNothing = (req, res, next) => {
    const { userId } = req.body;
    if (userId != req.user.id) {
      console.log('mismatch');
    }
    // ruleid: affidavit.idor.request-id-to-data-access
    accountDAO.updateStart(userId, 1, () => res.end());
  };

  this.nonIdField = (req, res, next) => {
    const { note } = req.body;
    // ok: affidavit.idor.request-id-to-data-access
    accountDAO.addNote(req.session.userId, note, () => res.end());
  };

  this.validatorIsNotDataAccess = (req, res, next) => {
    // ok: affidavit.idor.request-id-to-data-access
    const { error } = Joi.string().validate(req.body.userId);
    res.json({ error });
  };
}
