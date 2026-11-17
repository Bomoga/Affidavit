// Test file for rules/semgrep/idor-request-id.yaml. Not executed; only parsed by Semgrep.
function bodyIds(accountDAO, Order, prisma, Joi) {
  this.updateByBodyId = (req, res, next) => {
    // ruleid: affidavit.idor.request-id-to-data-access
    const { userId, startDate } = req.body;
    accountDAO.updateStart(userId, startDate, () => res.end());
  };

  this.queryId = (req, res, next) => {
    // ruleid: affidavit.idor.request-id-to-data-access
    const orderId = req.query.orderId;
    Order.findById(orderId);
  };

  this.letBinding = (req, res, next) => {
    // ruleid: affidavit.idor.request-id-to-data-access
    let owner_id = req.body.owner_id;
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
    // ruleid: affidavit.idor.request-id-to-data-access
    const orderID = req.body.orderID;
    Order.findById(orderID);
  };

  this.guardAfterTheCall = async (req, res, next) => {
    // ruleid: affidavit.idor.request-id-to-data-access
    const { userId } = req.body;
    await accountDAO.remove(userId);
    if (userId !== req.user.id) {
      return res.sendStatus(403);
    }
  };

  this.bareNextDoesNotStop = (req, res, next) => {
    // ruleid: affidavit.idor.request-id-to-data-access
    const { userId } = req.body;
    if (userId !== req.user.id) {
      next(new Error('forbidden'));
    }
    accountDAO.remove(userId);
  };

  this.csrfIsNotOwnership = (req, res, next) => {
    // ruleid: affidavit.idor.request-id-to-data-access
    const { userId } = req.body;
    if (userId !== req.session.csrfToken) {
      return res.sendStatus(403);
    }
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
    // ok: affidavit.idor.request-id-to-data-access
    const { userId } = req.body;
    if (userId !== req.user.id) return res.sendStatus(403);
    accountDAO.remove(userId);
  };

  this.guardedReturnNext = (req, res, next) => {
    // ok: affidavit.idor.request-id-to-data-access
    const { userId } = req.body;
    if (userId !== req.user.id) return next(new Error('forbidden'));
    accountDAO.remove(userId);
  };

  this.guarded = (req, res, next) => {
    // ok: affidavit.idor.request-id-to-data-access
    const { userId } = req.body;
    if (userId != req.user.id) {
      return res.sendStatus(403);
    }
    accountDAO.updateStart(userId, 1, () => res.end());
  };

  this.guardDoesNothing = (req, res, next) => {
    // ruleid: affidavit.idor.request-id-to-data-access
    const { userId } = req.body;
    if (userId != req.user.id) {
      console.log('mismatch');
    }
    accountDAO.updateStart(userId, 1, () => res.end());
  };

  this.nonIdField = (req, res, next) => {
    // ok: affidavit.idor.request-id-to-data-access
    const { note } = req.body;
    accountDAO.addNote(req.session.userId, note, () => res.end());
  };

  this.validatorIsNotDataAccess = (req, res, next) => {
    // ok: affidavit.idor.request-id-to-data-access
    const { error } = Joi.string().validate(req.body.userId);
    res.json({ error });
  };
}
