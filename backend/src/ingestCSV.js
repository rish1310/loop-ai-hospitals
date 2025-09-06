import fs from "fs";
import { parse } from "csv-parse";
import { v4 as uuidv4 } from "uuid";
import dotenv from "dotenv";
dotenv.config();

import { embedTexts } from "./genaiClient.js";
import { ensureCollection, upsertPointsFast, getAllExistingKeys } from "./qdrantClient.js";

const COLLECTION = "hospitals";
const INPUT_CSV = process.argv[2] || "./hospitals_sample.csv";

// Dynamic batch sizing based on API limits
const EMBEDDING_BATCH_SIZE = 100;
const DB_BATCH_SIZE = 500;
const MAX_CONCURRENT_EMBEDDINGS = 2;

async function readCsv(filePath) {
    return new Promise((resolve, reject) => {
        const rows = [];
        fs.createReadStream(filePath)
            .pipe(parse({ columns: false, trim: true, skip_empty_lines: true }))
            .on("data", row => rows.push(row))
            .on("end", () => resolve(rows))
            .on("error", err => reject(err));
    });
}

function parseHospitalRow(row) {
    if (!row || row.length < 3) {
        console.warn("Invalid row format:", row);
        return null;
    }

    const name = (row[0] || "").trim();
    const address = (row[1] || "").trim();
    const city = (row[2] || "").trim();

    if (!name) {
        console.warn("Missing hospital name in row:", row);
        return null;
    }

    return { name, address, city };
}

function createHospitalKey(hospital) {
    return `${hospital.name.toLowerCase().trim()}|${hospital.city.toLowerCase().trim()}|${hospital.address.toLowerCase().trim()}`;
}

async function processEmbeddingBatch(batch, batchIndex, totalBatches) {
    const texts = batch.map(hospital =>
        `${hospital.name} | ${hospital.address} | ${hospital.city}`
    );

    console.log(`🔄 Embedding batch ${batchIndex + 1}/${totalBatches} (${batch.length} hospitals)...`);

    let vectors;
    let retries = 0;
    const maxRetries = 3;

    while (retries < maxRetries) {
        try {
            vectors = await embedTexts(texts);
            break;
        } catch (error) {
            retries++;
            if (retries === maxRetries) {
                console.error(`❌ Failed to embed batch ${batchIndex + 1} after ${maxRetries} retries:`, error.message);
                throw error;
            }

            const delay = Math.min(1000 * Math.pow(2, retries), 5000); // Exponential backoff, max 5s
            console.log(`⚠️  Embedding failed, retry ${retries}/${maxRetries} for batch ${batchIndex + 1} (waiting ${delay}ms)`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }

    const points = batch.map((hospital, idx) => ({
        id: uuidv4(),
        vector: vectors[idx],
        payload: {
            name: hospital.name,
            address: hospital.address,
            city: hospital.city,
            city_exact: hospital.city,
            unique_key: createHospitalKey(hospital)
        }
    }));

    return points;
}

async function processDatabaseBatch(points, batchIndex, totalBatches) {
    console.log(`💾 Inserting batch ${batchIndex + 1}/${totalBatches} (${points.length} points)...`);

    let retries = 0;
    const maxRetries = 3;

    while (retries < maxRetries) {
        try {
            await upsertPointsFast(COLLECTION, points);
            return points.length;
        } catch (error) {
            retries++;
            if (retries === maxRetries) {
                console.error(`❌ Failed to insert batch ${batchIndex + 1} after ${maxRetries} retries:`, error.message);
                throw error;
            }

            const delay = 1000 * retries;
            console.log(`⚠️  Database insert failed, retry ${retries}/${maxRetries} for batch ${batchIndex + 1} (waiting ${delay}ms)`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

(async () => {
    const startTime = Date.now();
    console.log("🚀 Starting optimized hospital ingestion...");

    console.log("Ensuring collection...");
    await ensureCollection(COLLECTION, 768);

    console.log("Reading CSV:", INPUT_CSV);
    const rows = await readCsv(INPUT_CSV);
    console.log(`📄 Total rows found: ${rows.length}`);

    // Skip header row if it exists
    let dataRows = rows;
    if (rows.length > 0 && rows[0].some(cell =>
        cell?.toLowerCase().includes('hospital') ||
        cell?.toLowerCase().includes('name') ||
        cell?.toLowerCase().includes('address'))) {
        dataRows = rows.slice(1);
        console.log(`📋 Skipped header row, processing: ${dataRows.length} data rows`);
    }

    // Parse hospital data
    const hospitals = [];
    let skippedCount = 0;

    for (const row of dataRows) {
        const hospital = parseHospitalRow(row);
        if (!hospital) {
            skippedCount++;
            continue;
        }
        hospitals.push(hospital);
    }

    console.log(`✅ Parsed ${hospitals.length} valid hospitals`);

    const hospitalMap = new Map();
    let duplicateCount = 0;

    for (const hospital of hospitals) {
        const key = createHospitalKey(hospital);
        if (!hospitalMap.has(key)) {
            hospitalMap.set(key, hospital);
        } else {
            duplicateCount++;
        }
    }

    const uniqueHospitals = Array.from(hospitalMap.values());
    console.log(`🔍 Unique hospitals after deduplication: ${uniqueHospitals.length} (${duplicateCount} duplicates removed)`);

    console.log("🔍 Checking for existing records in database...");
    const existingKeys = await getAllExistingKeys(COLLECTION);
    console.log(`💾 Found ${existingKeys.size} existing records in database`);

    const newHospitals = uniqueHospitals.filter(hospital => {
        const key = createHospitalKey(hospital);
        return !existingKeys.has(key);
    });

    console.log(`➕ New hospitals to insert: ${newHospitals.length}`);
    if (newHospitals.length === 0) {
        console.log("✅ No new hospitals to process!");
        const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`⏱️  Total time: ${totalTime} seconds`);
        process.exit(0);
    }

    console.log(`🔄 Processing embeddings in batches of ${EMBEDDING_BATCH_SIZE}...`);

    const embeddingBatches = [];
    for (let i = 0; i < newHospitals.length; i += EMBEDDING_BATCH_SIZE) {
        embeddingBatches.push(newHospitals.slice(i, i + EMBEDDING_BATCH_SIZE));
    }

    let allPoints = [];
    let totalProcessed = 0;

    for (let i = 0; i < embeddingBatches.length; i += MAX_CONCURRENT_EMBEDDINGS) {
        const currentBatches = embeddingBatches.slice(i, i + MAX_CONCURRENT_EMBEDDINGS);

        const promises = currentBatches.map((batch, idx) =>
            processEmbeddingBatch(batch, i + idx, embeddingBatches.length)
        );

        try {
            const batchResults = await Promise.all(promises);

            for (const points of batchResults) {
                allPoints.push(...points);
                totalProcessed += points.length;
            }

            console.log(`✅ Embedding progress: ${totalProcessed}/${newHospitals.length} hospitals`);

            if (allPoints.length >= DB_BATCH_SIZE || i + MAX_CONCURRENT_EMBEDDINGS >= embeddingBatches.length) {
                const dbBatchIndex = Math.floor(totalProcessed / DB_BATCH_SIZE);
                const totalDbBatches = Math.ceil(newHospitals.length / DB_BATCH_SIZE);

                await processDatabaseBatch(allPoints, dbBatchIndex, totalDbBatches);
                allPoints = [];
            }

        } catch (error) {
            console.error(`❌ Error in embedding batch group starting at ${i + 1}:`, error);
        }
    }

    if (allPoints.length > 0) {
        await processDatabaseBatch(allPoints, Math.ceil(totalProcessed / DB_BATCH_SIZE), Math.ceil(newHospitals.length / DB_BATCH_SIZE));
    }

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
    const processingRate = (newHospitals.length / (totalTime / 60)).toFixed(0);

    console.log("\n🎉 CSV ingestion completed!");
    console.log("📊 Summary:");
    console.log(`   • Total rows read: ${dataRows.length}`);
    console.log(`   • Valid hospitals parsed: ${hospitals.length}`);
    console.log(`   • Duplicates removed: ${duplicateCount + (uniqueHospitals.length - newHospitals.length)}`);
    console.log(`   • New hospitals ingested: ${totalProcessed}`);
    console.log(`   • Total processing time: ${totalTime} seconds`);
    console.log(`   • Processing rate: ~${processingRate} hospitals/minute`);

    process.exit(0);
})();