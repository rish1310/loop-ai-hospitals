import express from "express";
import { parseIntentStructured, parseIntentFromAudio, textToSpeech, voiceToVoice, embedText } from "../genaiClient.js";
import { vectorSearch, fuzzyMatchHospital, hybridSearch } from "../qdrantClient.js";
import Twilio from "twilio";

const router = express.Router();
const COLLECTION = "hospitals";
const sessions = new Map();

//Optionally notify human via Twilio
async function notifyHuman(reqText) {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_FROM_NUMBER;
    const to = process.env.TWILIO_NOTIFY_NUMBER;
    if (!sid || !token || !from || !to) return;
    const client = Twilio(sid, token);
    await client.messages.create({
        from,
        to,
        body: `Loop AI forwarded an out-of-scope request: "${reqText}"`
    });
}

// Enhanced hospital search with better city matching
async function searchHospitals(city = null, limit = 3) {
    let results;

    if (city) {
        const searchQuery = `hospitals in ${city}`;
        const vec = await embedText(searchQuery);
        results = await hybridSearch(COLLECTION, vec, limit, city);
    } else {
        const vec = await embedText("hospitals");
        results = await vectorSearch(COLLECTION, vec, limit);
    }

    const hits = results?.result ?? results;

    return (hits || [])
        .map(h => {
            const p = h?.payload || {};
            return {
                name: p.name?.trim() || "Unknown",
                address: p.address?.trim() || "N/A",
                city: p.city?.trim() || "N/A",
                score: h.score ?? null
            };
        })
        .filter(it => it.name !== "Unknown");
}

//Enhanced hospital name similarity scoring
function calculateNameSimilarity(searchName, hospitalName) {
    const search = searchName.toLowerCase().trim();
    const hospital = hospitalName.toLowerCase().trim();

    if (search === hospital) return 1.0;

    if (hospital.includes(search) || search.includes(hospital)) return 0.9;

    const searchWords = search.split(/\s+/);
    const hospitalWords = hospital.split(/\s+/);

    let matchedWords = 0;
    for (const searchWord of searchWords) {
        for (const hospitalWord of hospitalWords) {
            if (hospitalWord.includes(searchWord) || searchWord.includes(hospitalWord)) {
                matchedWords++;
                break;
            }
        }
    }

    const wordMatchScore = matchedWords / Math.max(searchWords.length, hospitalWords.length);

    const keyTermBonus = searchWords.some(word =>
        hospitalWords.some(hWord => hWord.includes(word) && word.length >= 4)
    ) ? 0.2 : 0;

    return Math.min(1.0, wordMatchScore + keyTermBonus);
}

//Enhanced hospital confirmation with better fuzzy matching
async function confirmHospital(hospitalName, city) {
    try {

        const locationTerms = extractLocationTerms(hospitalName);
        const mainHospitalName = extractMainHospitalName(hospitalName);

        console.log(`Searching for: "${hospitalName}" -> Main: "${mainHospitalName}", Location: "${locationTerms.join(', ')}", City: "${city}"`);

        const searchQueries = [
            hospitalName,
            `${mainHospitalName} ${locationTerms.join(' ')}`,
            city ? `${hospitalName} ${city}` : hospitalName
        ];

        const allResults = [];
        const seen = new Set();

        for (const query of searchQueries) {
            try {
                const vec = await embedText(query);
                const semanticResults = await hybridSearch(COLLECTION, vec, 15, city);

                if (semanticResults?.result) {
                    for (const hit of semanticResults.result) {
                        const key = `${hit.payload?.name}|${hit.payload?.city}|${hit.payload?.address}`;
                        if (!seen.has(key)) {
                            seen.add(key);
                            allResults.push({ ...hit, source: 'semantic', searchQuery: query });
                        }
                    }
                }
            } catch (error) {
                console.warn(`Semantic search failed for query "${query}":`, error.message);
            }
        }

        try {
            const fuzzyResults = await fuzzyMatchHospital(COLLECTION, hospitalName);
            if (fuzzyResults?.result) {
                for (const hit of fuzzyResults.result) {
                    const key = `${hit.payload?.name}|${hit.payload?.city}|${hit.payload?.address}`;
                    if (!seen.has(key)) {
                        seen.add(key);
                        allResults.push({ ...hit, source: 'fuzzy' });
                    }
                }
            }
        } catch (error) {
            console.warn("Fuzzy search failed:", error.message);
        }

        let cityFiltered = filterByCity(allResults, city);

        const scoredResults = cityFiltered.map(hit => {
            const scoring = calculateEnhancedSimilarity(
                hospitalName,
                mainHospitalName,
                locationTerms,
                hit.payload
            );

            return {
                ...hit,
                ...scoring,
                totalSimilarity: scoring.totalScore
            };
        });

        scoredResults.sort((a, b) => b.totalSimilarity - a.totalSimilarity);

        const goodMatches = scoredResults.filter(hit => hit.totalSimilarity >= 0.25);

        console.log(`Hospital confirmation results for "${hospitalName}":`, {
            totalResults: allResults.length,
            afterCityFilter: cityFiltered.length,
            goodMatches: goodMatches.length,
            topMatches: goodMatches.slice(0, 3).map(m => ({
                name: m.payload?.name,
                address: m.payload?.address,
                city: m.payload?.city,
                totalScore: m.totalSimilarity,
                breakdown: {
                    nameScore: m.nameScore,
                    locationScore: m.locationScore,
                    addressScore: m.addressScore
                }
            }))
        });

        return goodMatches.slice(0, 3);

    } catch (error) {
        console.error("Error in confirmHospital:", error);
        return [];
    }
}

//Extract location terms from hospital name (e.g., "Sarjapur", "Jayanagar")
function extractLocationTerms(hospitalName) {
    const name = hospitalName.toLowerCase();
    const locationTerms = [];

    const locationPatterns = [
        /\b(sarjapur|jayanagar|bannerghatta|whitefield|koramangala|indiranagar|malleshwaram|rajajinagar|hebbal|marathahalli|electronic city|silk board|btm|hsr|jp nagar|mg road|brigade road|commercial street)\b/gi,
        /\b(\w+)\s+(road|street|cross|layout|nagar|pura)\b/gi,
        /\b(old|new)\s+(\w+)\b/gi
    ];

    for (const pattern of locationPatterns) {
        const matches = name.match(pattern);
        if (matches) {
            locationTerms.push(...matches.map(m => m.trim()));
        }
    }

    return [...new Set(locationTerms)];
}

//Extract main hospital name by removing common suffixes and location terms
function extractMainHospitalName(hospitalName) {
    let mainName = hospitalName.toLowerCase();

    mainName = mainName.replace(/\s+(sarjapur|jayanagar|bannerghatta|whitefield|koramangala|indiranagar|malleshwaram|rajajinagar|hebbal|marathahalli|electronic city|silk board|btm|hsr|jp nagar|mg road|brigade road|commercial street).*$/gi, '');
    mainName = mainName.replace(/\s+\w+\s+(road|street|cross|layout|nagar|pura).*$/gi, '');
    mainName = mainName.replace(/\s+(hospital|medical center|clinic)s?$/gi, '');

    return mainName.trim();
}

// Calculate enhanced similarity with weighted components
function calculateEnhancedSimilarity(originalQuery, mainName, locationTerms, payload) {
    const hospitalName = payload?.name || "";
    const hospitalAddress = payload?.address || "";
    const hospitalCity = payload?.city || "";

    const nameScore = calculateNameSimilarity(mainName, hospitalName) * 0.4;

    let locationScore = 0;
    if (locationTerms.length > 0) {
        const addressLower = hospitalAddress.toLowerCase();
        const nameLower = hospitalName.toLowerCase();

        let matchedTerms = 0;
        for (const term of locationTerms) {
            const termLower = term.toLowerCase();
            if (addressLower.includes(termLower) || nameLower.includes(termLower)) {
                matchedTerms++;
            }
            else if (termLower.length > 4) {
                const termParts = termLower.split(/[\s-]+/);
                for (const part of termParts) {
                    if (part.length >= 3 && (addressLower.includes(part) || nameLower.includes(part))) {
                        matchedTerms += 0.5;
                        break;
                    }
                }
            }
        }
        locationScore = Math.min(1.0, matchedTerms / locationTerms.length) * 0.35;
    }

    const addressScore = calculateAddressSimilarity(originalQuery, hospitalAddress) * 0.15;

    const overallNameScore = calculateNameSimilarity(originalQuery, hospitalName) * 0.1;

    const totalScore = nameScore + locationScore + addressScore + overallNameScore;

    return {
        nameScore,
        locationScore,
        addressScore,
        overallNameScore,
        totalScore,
        matchDetails: {
            mainName,
            locationTerms,
            hospitalName,
            hospitalAddress
        }
    };
}

// Calculate address similarity based on key terms
function calculateAddressSimilarity(query, address) {
    const queryLower = query.toLowerCase();
    const addressLower = address.toLowerCase();

    const queryTerms = queryLower.split(/\s+/).filter(term =>
        term.length >= 3 &&
        !['hospital', 'medical', 'center', 'clinic', 'the', 'and', 'of', 'in', 'at', 'on'].includes(term)
    );

    let matchCount = 0;
    for (const term of queryTerms) {
        if (addressLower.includes(term)) {
            matchCount++;
        }
    }

    return queryTerms.length > 0 ? matchCount / queryTerms.length : 0;
}

// Enhanced city filtering with better location matching
function filterByCity(results, city) {
    if (!city) return results;

    const cityLower = city.toLowerCase();

    return results.filter(h => {
        const resultCity = (h.payload?.city || "").toLowerCase();
        const resultAddress = (h.payload?.address || "").toLowerCase();

        if (resultCity === cityLower) return true;

        if (resultCity.includes(cityLower) || resultAddress.includes(cityLower)) return true;

        if (cityLower.includes(resultCity) && resultCity.length >= 3) return true;

        const cityMappings = {
            'bangalore': ['bengaluru', 'banglore'],
            'bengaluru': ['bangalore', 'banglore'],
            'mumbai': ['bombay'],
            'bombay': ['mumbai'],
            'delhi': ['new delhi'],
            'new delhi': ['delhi']
        };

        const variations = cityMappings[cityLower] || [];
        return variations.some(variation =>
            resultCity.includes(variation) || resultAddress.includes(variation)
        );
    });
}

router.post("/chat", async (req, res) => {
    try {
        const { sessionId, text } = req.body;
        if (!sessionId || !text) return res.status(400).json({ error: "sessionId and text required" });

        if (!sessions.has(sessionId)) sessions.set(sessionId, []);
        const session = sessions.get(sessionId);

        if (session.length === 0) {
            const intro = "Hello! I'm Loop AI, your hospital network assistant. How can I help you today?";
            const { audioBase64 } = await textToSpeech(intro);
            session.push({ role: "assistant", text: intro });
        }

        session.push({ role: "user", text });

        const intent = await parseIntentStructured(text);

        if (!intent || intent.action === "out_of_scope") {
            await notifyHuman(text);
            const reply = "I'm sorry, I can't help with that. Forwarding to a human agent.";
            const { audioBase64 } = await textToSpeech(reply);
            session.push({ role: "assistant", text: reply });
            return res.json({ reply, audioBase64, contentType: "audio/wav" });
        }

        if (intent.action === "confirm") {
            const hospitalName = intent.hospital_name || "";
            const city = intent.city || "";

            if (!hospitalName) {
                const reply = "Which hospital would you like me to check?";
                const { audioBase64 } = await textToSpeech(reply);
                session.push({ role: "assistant", text: reply });
                return res.json({ reply, audioBase64, contentType: "audio/wav" });
            }

            const matches = await confirmHospital(hospitalName, city);

            let reply;
            if (matches.length > 0) {
                const best = matches[0].payload || {};
                const similarity = matches[0].totalSimilarity || 0;

                if (similarity >= 0.7) {
                    reply = `Yes, ${best.name} at ${best.address}, ${best.city} is in your network.`;
                }
                else if (similarity >= 0.4) {
                    reply = `I found ${best.name} at ${best.address}, ${best.city}. Is this the hospital you're looking for?`;
                }
                else {
                    const alternativeNames = matches.slice(0, 2).map(m => m.payload.name).join(", ");
                    reply = `I couldn't find an exact match for "${hospitalName}"${city ? ` in ${city}` : ""}. Did you mean: ${alternativeNames}?`;
                }
            } else {
                const cityText = city ? ` in ${city}` : "";
                reply = `I could not find "${hospitalName}"${cityText} in the network. Could you check the spelling or try a different name?`;
            }

            const { audioBase64 } = await textToSpeech(reply);
            session.push({ role: "assistant", text: reply });
            return res.json({ reply, audioBase64, contentType: "audio/wav", items: matches });
        }
        if (intent.action === "search") {
            const city = intent.city?.trim() || null;
            const limit = intent.limit || 3;

            const items = await searchHospitals(city, limit);

            let summary;
            if (items.length === 0) {
                summary = city ? `I couldn't find any hospitals in ${city}.` : "I couldn't find any hospitals.";
            } else {
                summary = `Here ${items.length !== 1 ? "are" : "is"} ${items.length} hospital${items.length !== 1 ? "s" : ""}`;
                if (city) summary += ` in ${city}`;
                summary += ": " + items.map(it => `${it.name} in ${it.city}`).join(", ");
            }

            const { audioBase64 } = await textToSpeech(summary);
            session.push({ role: "assistant", text: summary });

            return res.json({ reply: summary, audioBase64, contentType: "audio/wav", items });
        }
        const fallback = "Sorry, I couldn't process that request.";
        const { audioBase64 } = await textToSpeech(fallback);
        session.push({ role: "assistant", text: fallback });
        return res.json({ reply: fallback, audioBase64, contentType: "audio/wav" });

    } catch (err) {
        console.error("chat error", err);
        res.status(500).json({ error: String(err) });
    }
});

router.post("/voice-chat", async (req, res) => {
    try {
        const { sessionId, audioBase64 } = req.body;
        if (!sessionId || !audioBase64) {
            return res.status(400).json({ error: "sessionId and audioBase64 required" });
        }

        if (!sessions.has(sessionId)) sessions.set(sessionId, []);
        const session = sessions.get(sessionId);
        if (session.length === 0) {
            const intro = "Hello! I'm Loop AI, your hospital network assistant. How can I help you today?";
            const { audioBase64: introAudio } = await textToSpeech(intro);
            session.push({ role: "assistant", text: intro });
        }
        const intent = await parseIntentFromAudio(audioBase64);
        session.push({ role: "user", text: `[Audio Input - Intent: ${intent.action}]` });

        if (!intent || intent.action === "out_of_scope") {
            await notifyHuman("[Audio Input - Out of Scope]");
            const reply = "I'm sorry, I can't help with that. Forwarding to a human agent.";
            const { audioBase64: replyAudio } = await textToSpeech(reply);
            session.push({ role: "assistant", text: reply });
            return res.json({ reply, audioBase64: replyAudio, contentType: "audio/wav" });
        }

        if (intent.action === "confirm") {
            const hospitalName = intent.hospital_name || "";
            const city = intent.city || "";

            if (!hospitalName) {
                const reply = "Which hospital would you like me to check?";
                const { audioBase64: replyAudio } = await textToSpeech(reply);
                session.push({ role: "assistant", text: reply });
                return res.json({ reply, audioBase64: replyAudio, contentType: "audio/wav" });
            }

            const matches = await confirmHospital(hospitalName, city);

            let reply;
            if (matches.length > 0) {
                const best = matches[0].payload || {};
                const similarity = matches[0].totalSimilarity || 0;
                if (similarity >= 0.7) {
                    reply = `Yes, ${best.name} at ${best.address}, ${best.city} is in your network.`;
                }
                else if (similarity >= 0.4) {
                    reply = `I found ${best.name} at ${best.address}, ${best.city}. Is this the hospital you're looking for?`;
                }
                else {
                    const alternativeNames = matches.slice(0, 2).map(m => m.payload.name).join(", ");
                    reply = `I couldn't find an exact match for "${hospitalName}"${city ? ` in ${city}` : ""}. Did you mean: ${alternativeNames}?`;
                }
            } else {
                const cityText = city ? ` in ${city}` : "";
                reply = `I could not find "${hospitalName}"${cityText} in the network. Could you check the spelling or try a different name?`;
            }

            const { audioBase64: replyAudio } = await textToSpeech(reply);
            session.push({ role: "assistant", text: reply });
            return res.json({ reply, audioBase64: replyAudio, contentType: "audio/wav", items: matches });
        }
        if (intent.action === "search") {
            const city = intent.city?.trim() || null;
            const limit = intent.limit || 3;

            const items = await searchHospitals(city, limit);

            let summary;
            if (items.length === 0) {
                summary = city ? `I couldn't find any hospitals in ${city}.` : "I couldn't find any hospitals.";
            } else {
                summary = `Here ${items.length !== 1 ? "are" : "is"} ${items.length} hospital${items.length !== 1 ? "s" : ""}`;
                if (city) summary += ` in ${city}`;
                summary += ": " + items.map(it => `${it.name} in ${it.city}`).join(", ");
            }

            const { audioBase64: replyAudio } = await textToSpeech(summary);
            session.push({ role: "assistant", text: summary });

            return res.json({ reply: summary, audioBase64: replyAudio, contentType: "audio/wav", items });
        }
        const fallback = "Sorry, I couldn't understand that request.";
        const { audioBase64: replyAudio } = await textToSpeech(fallback);
        session.push({ role: "assistant", text: fallback });
        return res.json({ reply: fallback, audioBase64: replyAudio, contentType: "audio/wav" });

    } catch (err) {
        console.error("voice chat error", err);
        res.status(500).json({ error: String(err) });
    }
});

export default router;