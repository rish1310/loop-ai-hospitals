import express from "express";
import dotenv from "dotenv";
import bodyParser from "body-parser";
import cors from "cors";

import chatRoutes from "./routes/chatRoutes.js";
import searchRoutes from "./routes/searchRoutes.js";
import ingestRoutes from "./routes/ingestRoutes.js";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors({
    origin: ["http://localhost:5173", "http://localhost:3000"],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
    credentials: true
}));

app.use(bodyParser.json({ limit: "50mb" }));
app.use(bodyParser.urlencoded({ extended: true, limit: "50mb" }));

app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
});

app.use("/api", chatRoutes);
app.use("/api", searchRoutes);
app.use("/api/ingest", ingestRoutes);

app.get("/health", (req, res) => {
    const healthStatus = {
        ok: true,
        timestamp: new Date().toISOString(),
        env: {
            node_version: process.version,
            port: PORT,
            has_google_key: !!process.env.GOOGLE_API_KEY,
            has_qdrant_url: !!process.env.QDRANT_URL,
            has_twilio_config: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN)
        }
    };
    res.json(healthStatus);
});

app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({
        error: 'Internal server error',
        message: err.message,
        timestamp: new Date().toISOString()
    });
});

app.use('*', (req, res) => {
    res.status(404).json({
        error: 'Route not found',
        path: req.originalUrl,
        timestamp: new Date().toISOString()
    });
});

app.listen(PORT, () => {
    console.log(`🚀 Loop AI backend running on http://localhost:${PORT}`);
    console.log(`📝 API endpoints available:`);
    console.log(`   - POST /api/chat (text chat)`);
    console.log(`   - POST /api/voice-chat (voice chat)`);
    console.log(`   - POST /api/search (hospital search)`);
    console.log(`   - GET  /health (health check)`);

    if (!process.env.GOOGLE_API_KEY) {
        console.warn("⚠️  GOOGLE_API_KEY not set - AI features will not work");
    }
    if (!process.env.QDRANT_URL) {
        console.warn("⚠️  QDRANT_URL not set - vector search will not work");
    }
});