const express = require("express");
const router = express.Router();
const { requireAuth } = require("../middlewares/auth.middleware");
const { upload, uploadDocument: uploadDocumentMw } = require("../middlewares/upload.middleware");
const { uploadAvatar, uploadDocument } = require("../controllers/files.controller");

// Avatar upload (requires authentication)
router.post("/avatar", upload.single("avatar"), uploadAvatar);

// Verification document upload (Photo ID, Proof of Address, Other Support)
router.post("/document", requireAuth, uploadDocumentMw.single("document"), uploadDocument);

module.exports = router;
