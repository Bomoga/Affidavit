// Test file for rules/semgrep/idor-request-id.yaml. Not executed; only parsed by Semgrep.
// The finding is on the statement that reads the identifier from the request.
function bodyIds(accountDAO, Order) {
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

  this.guarded = (req, res, next) => {
    // ok: affidavit.idor.request-id-to-data-access
    const { userId } = req.body;
    if (userId != req.user.id) {
      return res.sendStatus(403);
    }
    accountDAO.updateStart(userId, 1, () => res.end());
  };

  this.nonIdField = (req, res, next) => {
    // ok: affidavit.idor.request-id-to-data-access
    const { note } = req.body;
    accountDAO.addNote(req.session.userId, note, () => res.end());
  };
}
