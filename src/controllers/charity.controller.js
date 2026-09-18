const { ok, fail } = require("../utils/standardResponse");
const CharityService = require("../services/charity.service");
const CharityPaymentService = require("../services/charityPayment.service");
const CharityNotificationService = require("../services/charityNotification.service");
const { logCharityChange } = require("../middlewares/audit.middleware");

/**
 * Create a new charity application
 * POST /api/promoter/charity/applications
 */
async function createCharityApplication(req, res) {
  try {
    const promoterId = req.user.id;

    const {
      event_id,
      charity_name,
      charity_number,
      charity_description,
      charity_website,
      charitable_objectives,
      beneficiary_details,
      requested_amount
    } = req.body;

    // Validation
    if (!charity_name || !charity_number || !charity_description || !charitable_objectives || !requested_amount) {
      return fail(res, req, 400, "VALIDATION_ERROR", "Missing required fields");
    }

    if (requested_amount <= 0) {
      return fail(res, req, 400, "VALIDATION_ERROR", "Requested amount must be greater than 0");
    }

    if (requested_amount > 100000000) { // Max £1,000,000
      return fail(res, req, 400, "VALIDATION_ERROR", "Requested amount exceeds maximum limit");
    }

    const application = await CharityService.createApplication(
      {
        event_id,
        charity_name,
        charity_number,
        charity_description,
        charity_website,
        charitable_objectives,
        beneficiary_details,
        requested_amount
      },
      promoterId
    );

    return ok(res, req, { application }, 201);
  } catch (err) {
    console.error('Create charity application error:', err);
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  }
}

/**
 * List my charity applications
 * GET /api/charity/applications
 */
async function listMyApplications(req, res) {
  try {
    const promoterId = req.user.id;

    const {
      status,
      event_id,
      limit = 20,
      offset = 0
    } = req.query;

    const filters = {};
    if (status) filters.status = status;
    if (event_id) filters.event_id = event_id;
    if (limit) filters.limit = parseInt(limit);
    if (offset) filters.offset = parseInt(offset);

    const applications = await CharityService.listApplications(promoterId, filters);

    return ok(res, req, { applications });
  } catch (err) {
    console.error('List charity applications error:', err);
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  }
}

/**
 * Get charity application details
 * GET /api/charity/applications/:id
 */
async function getApplication(req, res) {
  try {
    const promoterId = req.user.id;
    const applicationId = parseInt(req.params.id);

    if (isNaN(applicationId) || applicationId <= 0) {
      return fail(res, req, 400, "VALIDATION_ERROR", "Invalid application ID");
    }

    const application = await CharityService.getApplication(applicationId, promoterId);

    if (!application) {
      return fail(res, req, 404, "NOT_FOUND", "Charity application not found");
    }

    return ok(res, req, { application });
  } catch (err) {
    console.error('Get charity application error:', err);
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  }
}

/**
 * Update draft charity application
 * PUT /api/charity/applications/:id
 */
async function updateApplication(req, res) {
  try {
    const promoterId = req.user.id;
    const applicationId = parseInt(req.params.id);

    if (isNaN(applicationId) || applicationId <= 0) {
      return fail(res, req, 400, "VALIDATION_ERROR", "Invalid application ID");
    }

    const {
      charity_name,
      charity_number,
      charity_description,
      charity_website,
      charitable_objectives,
      beneficiary_details,
      requested_amount
    } = req.body;

    // Validation
    if (!charity_name || !charity_number || !charity_description || !charitable_objectives || !requested_amount) {
      return fail(res, req, 400, "VALIDATION_ERROR", "Missing required fields");
    }

    if (requested_amount <= 0) {
      return fail(res, req, 400, "VALIDATION_ERROR", "Requested amount must be greater than 0");
    }

    const application = await CharityService.updateDraftApplication(
      applicationId,
      promoterId,
      {
        charity_name,
        charity_number,
        charity_description,
        charity_website,
        charitable_objectives,
        beneficiary_details,
        requested_amount
      }
    );

    return ok(res, req, { application });
  } catch (err) {
    console.error('Update charity application error:', err);
    if (err.message === 'Application not found') {
      return fail(res, req, 404, "NOT_FOUND", err.message);
    }
    if (err.message === 'Only DRAFT applications can be updated') {
      return fail(res, req, 400, "INVALID_STATE", err.message);
    }
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  }
}

/**
 * Submit charity application for review
 * POST /api/charity/applications/:id/submit
 */
async function submitApplication(req, res) {
  try {
    const promoterId = req.user.id;
    const applicationId = parseInt(req.params.id);

    if (isNaN(applicationId) || applicationId <= 0) {
      return fail(res, req, 400, "VALIDATION_ERROR", "Invalid application ID");
    }

    const application = await CharityService.submitApplication(applicationId, promoterId);

    // Log audit event
    await logCharityChange(req, 'charity_application_submitted', application.id, {
      fieldName: 'status',
      oldValue: 'DRAFT',
      newValue: 'SUBMITTED'
    });

    // Get full application with promoter info
    const fullApplication = await CharityService.getApplication(applicationId, promoterId);

    // Notify admins
    const promoter = {
      email: req.user.email,
      name: req.user.name
    };
    await CharityNotificationService.notifyAdminsOfNewApplication(fullApplication, promoter);

    // Notify promoter
    await CharityNotificationService.notifyApplicationSubmitted(fullApplication, promoter);

    return ok(res, req, { application }, 202);
  } catch (err) {
    console.error('Submit charity application error:', err);
    if (err.message === 'Application not found') {
      return fail(res, req, 404, "NOT_FOUND", err.message);
    }
    if (err.message === 'Only DRAFT applications can be submitted') {
      return fail(res, req, 400, "INVALID_STATE", err.message);
    }
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  }
}

/**
 * Pay charity application fee
 * POST /api/charity/applications/:id/pay-fee
 */
async function payApplicationFee(req, res) {
  try {
    const promoterId = req.user.id;
    const applicationId = parseInt(req.params.id);

    if (isNaN(applicationId) || applicationId <= 0) {
      return fail(res, req, 400, "VALIDATION_ERROR", "Invalid application ID");
    }

    const { idempotency_key } = req.body;

    // Validate idempotency key
    if (!idempotency_key) {
      return fail(res, req, 400, "VALIDATION_ERROR", "Idempotency key is required");
    }

    if (!CharityPaymentService.isValidIdempotencyKey(idempotency_key)) {
      return fail(res, req, 400, "VALIDATION_ERROR", "Invalid idempotency key");
    }

    const payment = await CharityPaymentService.createPaymentIntent(
      applicationId,
      promoterId,
      idempotency_key
    );

    return ok(res, req, { payment });
  } catch (err) {
    console.error('Pay charity application fee error:', err);
    if (err.message === 'Application not found') {
      return fail(res, req, 404, "NOT_FOUND", err.message);
    }
    if (err.message === 'Application must be in SUBMITTED status to pay fee') {
      return fail(res, req, 400, "INVALID_STATE", err.message);
    }
    if (err.message === 'Fee already paid for this application') {
      return fail(res, req, 400, "ALREADY_PAID", err.message);
    }
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  }
}

/**
 * Get application status
 * GET /api/charity/applications/:id/status
 */
async function getApplicationStatus(req, res) {
  try {
    const promoterId = req.user.id;
    const applicationId = parseInt(req.params.id);

    if (isNaN(applicationId) || applicationId <= 0) {
      return fail(res, req, 400, "VALIDATION_ERROR", "Invalid application ID");
    }

    const application = await CharityService.getApplication(applicationId, promoterId);

    if (!application) {
      return fail(res, req, 404, "NOT_FOUND", "Charity application not found");
    }

    const status = {
      id: application.id,
      status: application.status,
      decision_amount: application.decision_amount,
      admin_notes: application.admin_notes,
      reviewed_at: application.reviewed_at,
      updated_at: application.updated_at
    };

    return ok(res, req, { status });
  } catch (err) {
    console.error('Get charity application status error:', err);
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  }
}

/**
 * Get executions for an application
 * GET /api/charity/applications/:id/executions
 */
async function getExecutions(req, res) {
  try {
    const promoterId = req.user.id;
    const applicationId = parseInt(req.params.id);

    if (isNaN(applicationId) || applicationId <= 0) {
      return fail(res, req, 400, "VALIDATION_ERROR", "Invalid application ID");
    }

    // Verify application belongs to promoter
    const application = await CharityService.getApplication(applicationId, promoterId);

    if (!application) {
      return fail(res, req, 404, "NOT_FOUND", "Charity application not found");
    }

    const executions = await CharityService.getExecutions(applicationId);

    return ok(res, req, { executions });
  } catch (err) {
    console.error('Get charity executions error:', err);
    return fail(res, req, 500, "INTERNAL_ERROR", err.message);
  }
}

module.exports = {
  createApplication: createCharityApplication,
  listMyApplications,
  getApplication,
  updateApplication,
  submitApplication,
  payApplicationFee,
  getApplicationStatus,
  getExecutions
};
