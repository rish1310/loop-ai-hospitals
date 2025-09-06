import express from "express";
import { embedText } from "../genaiClient.js";
import { vectorSearch } from "../qdrantClient.js";
const router = express.Router();

const COLLECTION = "hospitals";

router.post("/search", async (req, res) => {
    try {
        const { q, city, limit = 3 } = req.body;
        const query = city ? `${q} in ${city}` : q;
        const vec = await embedText(query);
        const result = await vectorSearch(COLLECTION, vec, limit);
        return res.json({ results: result.result ?? result });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: String(err) });
    }
});

export default router;
