const pool = require("../db");

/**
 * Upload avatar image
 * POST /files/avatar
 */
async function uploadAvatar(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({
        error: true,
        message: "Avatar image file is required.",
        data: null,
      });
    }

    // Construct the URL for the uploaded file
    const avatarUrl = `${process.env.BACKEND_URL}/uploads/${req.file.filename}`;
    console.log("Avatar URL:", avatarUrl);



    // Save avatar URL to user record if user_id is provided
    const userId = req.body.user_id;
    if (userId) {
      await pool.query(
        "UPDATE users SET avatar_url = $1, updated_at = NOW() WHERE id = $2",
        [avatarUrl, userId]
      );
    }

    return res.json({
      error: false,
      message: "Avatar uploaded successfully.",
      data: {
        avatarUrl,
        ...(userId ? { userId } : {}),
      },
    });
  } catch (err) {
    console.error("Upload avatar error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to upload avatar at the moment. Please try again later.",
      data: null,
    });
  }
}


/**
 * Upload verification document (Photo ID, Proof of Address, Other Support)
 * POST /files/document
 * Body: form-data with "document" file and optional "type" (photo_id | proof_of_address | other_support)
 */
async function uploadDocument(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({
        error: true,
        message: "Document file is required.",
        data: null,
      });
    }

    const docUrl = `${process.env.BACKEND_URL || ""}/uploads/${req.file.filename}`;

    return res.json({
      error: false,
      message: "Document uploaded successfully.",
      data: {
        url: docUrl,
        type: req.body.type || null,
        filename: req.file.filename,
      },
    });
  } catch (err) {
    console.error("Upload document error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to upload document at the moment. Please try again later.",
      data: null,
    });
  }
}

module.exports = {
  uploadAvatar,
  uploadDocument,
};
