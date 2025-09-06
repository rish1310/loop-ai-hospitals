import express from "express";
import multer from "multer";
const upload = multer({ dest: "/tmp" });
const router = express.Router();

// Accept a CSV file and run the ingest script.
router.post("/upload-csv", upload.single("csv"), async (req, res) => {
    try {
        res.json({ message: "File received. For demo use the backend ingest script (npm run ingest)" });
    } catch (err) {
        res.status(500).json({ error: String(err) });
    }
});

export default router;
