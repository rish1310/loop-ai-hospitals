import dotenv from "dotenv";
dotenv.config();

const QDRANT_URL = process.env.QDRANT_URL;
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;
if (!QDRANT_URL) console.warn("QDRANT_URL not set");

function headers() {
    const h = { "Content-Type": "application/json" };
    if (QDRANT_API_KEY) h["api-key"] = QDRANT_API_KEY;
    return h;
}

export async function ensureCollection(collectionName, dimension = 768) {
    const url = `${QDRANT_URL}/collections/${collectionName}`;
    const body = {
        vectors: {
            size: dimension,
            distance: "Cosine"
        },
        optimizers_config: {
            default_segment_number: 2
        },
        replication_factor: 1
    };

    const resp = await fetch(url, {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify(body)
    });

    if (!resp.ok) {
        const txt = await resp.text();
        if (!txt.includes("already exists")) {
            throw new Error("Qdrant ensureCollection failed: " + txt);
        }
    }

    // Create proper indexes
    await createPayloadIndex(collectionName, "name", "text");
    await createPayloadIndex(collectionName, "city", "text");
    await createPayloadIndex(collectionName, "city_exact", "keyword");
    await createPayloadIndex(collectionName, "address", "text");
    await createPayloadIndex(collectionName, "unique_key", "keyword");

    return true;
}

async function createPayloadIndex(collectionName, fieldName, fieldType) {
    const url = `${QDRANT_URL}/collections/${collectionName}/index`;
    const body = { field_name: fieldName, field_schema: fieldType };
    const resp = await fetch(url, {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify(body)
    });

    if (!resp.ok) {
        const txt = await resp.text();
        if (!txt.includes("already exists")) {
            console.warn(`⚠️ Failed to create index for ${fieldName}:`, txt);
        }
    }
}

// Retrieve all existing unique keys to avoid duplicates
export async function getAllExistingKeys(collectionName) {
    const existingKeys = new Set();
    let offset = null;
    const limit = 1000;

    try {
        while (true) {
            const url = `${QDRANT_URL}/collections/${collectionName}/points/scroll`;
            const body = {
                limit,
                with_payload: ["unique_key"],
                with_vector: false
            };

            if (offset) {
                body.offset = offset;
            }

            const resp = await fetch(url, {
                method: "POST",
                headers: headers(),
                body: JSON.stringify(body)
            });

            if (!resp.ok) {
                const txt = await resp.text();
                if (txt.includes("Not found")) {
                    break;
                }
                throw new Error("Failed to scroll existing keys: " + txt);
            }

            const result = await resp.json();
            const points = result.result.points || [];

            if (points.length === 0) break;

            for (const point of points) {
                if (point.payload?.unique_key) {
                    existingKeys.add(point.payload.unique_key);
                }
            }

            offset = result.result.next_page_offset;
            if (!offset) break;

            console.log(`Loaded ${existingKeys.size} existing keys...`);
        }
    } catch (error) {
        if (error.message.includes("Not found")) {
            console.log("Collection doesn't exist yet, no existing keys");
            return new Set();
        }
        throw error;
    }

    return existingKeys;
}

// Upsert points in batches
export async function upsertPointsFast(collectionName, points) {
    if (!points || points.length === 0) {
        console.log("No points to insert");
        return { status: "ok", result: { operation_id: null, status: "completed" } };
    }

    const url = `${QDRANT_URL}/collections/${collectionName}/points?wait=true`;
    const resp = await fetch(url, {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify({ points })
    });

    if (!resp.ok) {
        const txt = await resp.text();
        throw new Error("Qdrant upsert failed: " + txt);
    }

    const result = await resp.json();
    return result;
}

// Keep the original upsertPoints for backward compatibility
export async function upsertPoints(collectionName, points) {
    const filteredPoints = [];
    const existingKeys = await getAllExistingKeys(collectionName);

    for (const point of points) {
        const uniqueKey = point.payload.unique_key;
        if (uniqueKey && existingKeys.has(uniqueKey)) {
            console.log(`Skipping duplicate: ${point.payload.name} in ${point.payload.city}`);
            continue;
        }

        filteredPoints.push({
            ...point,
            payload: {
                ...point.payload,
                city_exact: point.payload.city
            }
        });
    }

    return await upsertPointsFast(collectionName, filteredPoints);
}

export async function vectorSearch(collectionName, vector, topK = 5, filter = null) {
    const url = `${QDRANT_URL}/collections/${collectionName}/points/search`;
    const body = {
        vector,
        limit: topK,
        with_payload: true,
        score_threshold: 0.3
    };
    if (filter) body.filter = filter;

    const resp = await fetch(url, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(body)
    });
    if (!resp.ok) {
        const txt = await resp.text();
        throw new Error("Qdrant search failed: " + txt);
    }
    return resp.json();
}

// Strict exact match by city (keyword match)
export async function exactMatchByCity(collectionName, city) {
    const url = `${QDRANT_URL}/collections/${collectionName}/points/search`;
    const body = {
        vector: Array(768).fill(0.0),
        limit: 20,
        filter: {
            must: [{ key: "city_exact", match: { value: city } }]
        },
        with_payload: true
    };
    const resp = await fetch(url, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(body)
    });
    if (!resp.ok) {
        const txt = await resp.text();
        throw new Error("Qdrant city match failed: " + txt);
    }
    return resp.json();
}

// Strict exact match by name
export async function exactMatchByName(collectionName, hospitalName) {
    const url = `${QDRANT_URL}/collections/${collectionName}/points/search`;
    const body = {
        vector: Array(768).fill(0.0),
        limit: 10,
        filter: {
            must: [{ key: "name", match: { text: hospitalName } }]
        },
        with_payload: true
    };
    const resp = await fetch(url, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(body)
    });
    if (!resp.ok) {
        const txt = await resp.text();
        throw new Error("Qdrant exact match failed: " + txt);
    }
    return resp.json();
}

// Enhanced fuzzy / partial matching on name, address, and city
export async function fuzzyMatchHospital(collectionName, query) {
    const url = `${QDRANT_URL}/collections/${collectionName}/points/search`;
    const body = {
        vector: Array(768).fill(0.0),
        limit: 20,
        filter: {
            should: [
                { key: "name", match: { text: query } },
                { key: "address", match: { text: query } },
                { key: "city", match: { text: query } }
            ]
        },
        with_payload: true
    };
    const resp = await fetch(url, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(body)
    });
    if (!resp.ok) {
        const txt = await resp.text();
        throw new Error("Qdrant fuzzy match failed: " + txt);
    }
    return resp.json();
}

// Fixed hybrid search with proper index usage
export async function hybridSearch(collectionName, queryVector, topK = 5, cityFilter = null) {
    const url = `${QDRANT_URL}/collections/${collectionName}/points/search`;
    const body = {
        vector: queryVector,
        limit: topK * 2,
        with_payload: true,
        score_threshold: 0.1
    };

    if (cityFilter) {
        body.filter = {
            should: [
                { key: "city_exact", match: { value: cityFilter } },
                { key: "city", match: { text: cityFilter } },
                { key: "address", match: { text: cityFilter } }
            ]
        };
    }

    const resp = await fetch(url, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(body)
    });

    if (!resp.ok) {
        const txt = await resp.text();
        throw new Error("Qdrant hybridSearch failed: " + txt);
    }

    const results = await resp.json();

    if (results.result) {
        const seen = new Set();
        const uniqueResults = [];

        for (const result of results.result) {
            const uniqueKey = result.payload?.unique_key ||
                `${result.payload?.name}|${result.payload?.city}|${result.payload?.address}`;

            if (!seen.has(uniqueKey)) {
                seen.add(uniqueKey);
                uniqueResults.push(result);
            }
        }

        if (cityFilter) {
            const cityLower = cityFilter.toLowerCase();
            const exactMatches = uniqueResults.filter(r =>
                (r.payload?.city || "").toLowerCase() === cityLower
            );
            const partialMatches = uniqueResults.filter(r =>
                (r.payload?.city || "").toLowerCase() !== cityLower &&
                ((r.payload?.city || "").toLowerCase().includes(cityLower) ||
                    (r.payload?.address || "").toLowerCase().includes(cityLower))
            );

            results.result = [...exactMatches, ...partialMatches].slice(0, topK);
        } else {
            results.result = uniqueResults.slice(0, topK);
        }
    }

    return results;
}

// Multi-step search: First try semantic search, then fallback to text matching
export async function smartHospitalSearch(collectionName, queryVector, searchTerm, city = null, topK = 5) {
    try {
        const semanticResults = await hybridSearch(collectionName, queryVector, topK, city);

        if (semanticResults.result && semanticResults.result.length > 0) {
            return semanticResults;
        }
        console.log("Semantic search returned no results, trying fuzzy matching...");
        const fuzzyResults = await fuzzyMatchHospital(collectionName, searchTerm);

        if (fuzzyResults.result) {
            const seen = new Set();
            let filtered = [];

            for (const result of fuzzyResults.result) {
                const uniqueKey = result.payload?.unique_key ||
                    `${result.payload?.name}|${result.payload?.city}|${result.payload?.address}`;

                if (seen.has(uniqueKey)) continue;
                seen.add(uniqueKey);

                if (city) {
                    const cityLower = city.toLowerCase();
                    const resultCity = (result.payload?.city || "").toLowerCase();
                    const resultAddress = (result.payload?.address || "").toLowerCase();

                    if (resultCity.includes(cityLower) || resultAddress.includes(cityLower)) {
                        filtered.push(result);
                    }
                } else {
                    filtered.push(result);
                }
            }

            fuzzyResults.result = filtered.slice(0, topK);
        }

        return fuzzyResults;

    } catch (error) {
        console.error("Smart search error:", error);
        throw error;
    }
}

// City-focused search with fallback strategies
export async function searchByCity(collectionName, city, topK = 10) {
    try {
        const exactResults = await exactMatchByCity(collectionName, city);
        if (exactResults.result && exactResults.result.length > 0) {
            const seen = new Set();
            const uniqueResults = exactResults.result.filter(result => {
                const uniqueKey = result.payload?.unique_key ||
                    `${result.payload?.name}|${result.payload?.city}|${result.payload?.address}`;
                if (seen.has(uniqueKey)) return false;
                seen.add(uniqueKey);
                return true;
            });

            return {
                ...exactResults,
                result: uniqueResults.slice(0, topK)
            };
        }

        const fuzzyResults = await fuzzyMatchHospital(collectionName, city);
        const cityLower = city.toLowerCase();
        const seen = new Set();
        const filtered = (fuzzyResults.result || []).filter(r => {
            const uniqueKey = r.payload?.unique_key ||
                `${r.payload?.name}|${r.payload?.city}|${r.payload?.address}`;

            if (seen.has(uniqueKey)) return false;
            seen.add(uniqueKey);

            const resultCity = (r.payload?.city || "").toLowerCase();
            const resultAddress = (r.payload?.address || "").toLowerCase();
            return resultCity.includes(cityLower) || resultAddress.includes(cityLower);
        });

        return {
            ...fuzzyResults,
            result: filtered.slice(0, topK)
        };

    } catch (error) {
        console.error("City search error:", error);
        throw error;
    }
}

// Get collection info for debugging
export async function getCollectionInfo(collectionName) {
    const url = `${QDRANT_URL}/collections/${collectionName}`;
    const resp = await fetch(url, {
        method: "GET",
        headers: headers()
    });

    if (!resp.ok) {
        const txt = await resp.text();
        throw new Error("Failed to get collection info: " + txt);
    }
    return resp.json();
}

// Count total points in collection
export async function countPoints(collectionName) {
    const url = `${QDRANT_URL}/collections/${collectionName}/points/count`;
    const resp = await fetch(url, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({})
    });

    if (!resp.ok) {
        const txt = await resp.text();
        throw new Error("Failed to count points: " + txt);
    }
    return resp.json();
}

// Delete collection (for testing/cleanup)
export async function deleteCollection(collectionName) {
    const url = `${QDRANT_URL}/collections/${collectionName}`;
    const resp = await fetch(url, {
        method: "DELETE",
        headers: headers()
    });

    if (!resp.ok) {
        const txt = await resp.text();
        throw new Error("Failed to delete collection: " + txt);
    }
    return resp.json();
}