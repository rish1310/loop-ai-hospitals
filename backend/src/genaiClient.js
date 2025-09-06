import dotenv from "dotenv";
dotenv.config();

const GOOGLE_KEY = process.env.GOOGLE_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;

if (!GOOGLE_KEY) {
    console.warn("Warning: GOOGLE_API_KEY not set — embeddings will fail until set.");
}
if (!ELEVENLABS_API_KEY) {
    console.warn("Warning: ELEVENLABS_API_KEY not set — voice features will fail until set.");
}

/**
 * Single text embedding (keeping Google for embeddings)
 */
export async function embedText(text) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${GOOGLE_KEY}`;

    const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model: "models/text-embedding-004",
            content: { parts: [{ text }] }
        })
    });

    if (!resp.ok) {
        const txt = await resp.text();
        throw new Error("embedText error: " + resp.status + " - " + txt);
    }

    const j = await resp.json();
    return j?.embedding?.values || [];
}

//Batch embeddings (keeping Google for embeddings)
export async function embedTexts(texts) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:batchEmbedContents?key=${GOOGLE_KEY}`;
    const body = {
        requests: texts.map(text => ({
            model: "models/text-embedding-004",
            content: { parts: [{ text }] }
        }))
    };

    const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
    });

    if (!resp.ok) {
        const txt = await resp.text();
        throw new Error("embedTexts error: " + resp.status + " - " + txt);
    }

    const j = await resp.json();
    return j?.embeddings?.map(e => e.values) || [];
}

// Convert audio to text using Google's Gemini (more reliable)
export async function speechToText(audioBase64) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${GOOGLE_KEY}`;

    const body = {
        contents: [{
            parts: [
                {
                    inlineData: {
                        mimeType: "audio/webm",
                        data: audioBase64
                    }
                },
                { text: "Please transcribe this audio to text only. Do not add any commentary, just the transcription." }
            ]
        }],
        generationConfig: {
            temperature: 0.0,
            maxOutputTokens: 1000
        }
    };

    const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
    });

    if (!resp.ok) {
        const txt = await resp.text();
        throw new Error("Gemini STT error: " + resp.status + " - " + txt);
    }

    const result = await resp.json();
    const transcription = result?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!transcription) {
        throw new Error("No transcription returned from Gemini");
    }

    return transcription.trim();
}

// Parse intent from audio input
export async function parseIntentFromAudio(audioBase64) {
    try {
        const transcription = await speechToText(audioBase64);

        if (!transcription) {
            console.warn("No transcription returned, treating as out_of_scope");
            return { action: "out_of_scope" };
        }
        return await parseIntentStructured(transcription);

    } catch (error) {
        console.error("Audio intent parsing error:", error);
        return { action: "out_of_scope" };
    }
}

// Parse structured intent from user text using Gemini
export async function parseIntentStructured(userText) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GOOGLE_KEY}`;

    const prompt = `You are an assistant named "Loop AI" whose job is to parse user requests about hospitals.
Return ONLY a JSON object (no explanation) with the following fields:
- action: one of "search", "confirm", "out_of_scope"
- city: (string) optional - extract city names, including variations like "Bangalore"/"Bengaluru"
- hospital_name: (string) optional - extract hospital names, including partial names and location identifiers
- limit: (integer) optional

IMPORTANT INSTRUCTIONS for hospital name extraction:
- Extract the main hospital name even if it includes location identifiers (e.g., "Manipal Sarjapur" from "Manipal Sarjapur in Bangalore")
- Include branch/location identifiers as part of the hospital name (e.g., "Apollo Cradle Jayanagar", "Manipal Sarjapur")
- For confirmation queries, extract the full hospital identifier mentioned by the user
- Common hospital name patterns: "[Brand Name] [Location]", "[Hospital] [Branch]", "[Name] Hospital [Area]"

Examples:
"Tell me 3 hospitals around Bangalore" → {"action":"search","city":"Bangalore","limit":3}
"Can you confirm if Manipal Sarjapur in Bangalore is in my network" → {"action":"confirm","city":"Bangalore","hospital_name":"Manipal Sarjapur"}
"Is Apollo Cradle Jayanagar covered?" → {"action":"confirm","hospital_name":"Apollo Cradle Jayanagar"}
"Find Fortis Hospital Bannerghatta Road" → {"action":"confirm","hospital_name":"Fortis Hospital Bannerghatta Road"}
"Show me hospitals in Mumbai" → {"action":"search","city":"Mumbai"}
"What's the weather like?" → {"action":"out_of_scope"}

Rules:
- Do NOT include markdown formatting like \`\`\`json or \`\`\`.
- Only return a valid JSON object.
- For city names, accept common variations (Bangalore/Bengaluru, Mumbai/Bombay, etc.)
- For hospital names, capture the full name as the user mentioned it

User text: """${userText}"""`;

    const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.0, maxOutputTokens: 350 }
        })
    });

    const j = await resp.json();
    let outText = j?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!outText) throw new Error("No structured response from model: " + JSON.stringify(j));

    outText = outText.replace(/```json/gi, "").replace(/```/g, "").trim();

    try {
        const parsed = JSON.parse(outText);

        // Post-process to handle common city variations
        if (parsed.city) {
            const cityLower = parsed.city.toLowerCase();
            if (cityLower.includes('bangalore') || cityLower.includes('bengaluru')) {
                parsed.city = 'Bengaluru';
            } else if (cityLower.includes('mumbai') || cityLower.includes('bombay')) {
                parsed.city = 'Mumbai';
            } else if (cityLower.includes('delhi')) {
                parsed.city = 'Delhi';
            }
        }

        return parsed;
    } catch {
        console.warn("Failed to parse JSON from model:", outText);
        return { action: "out_of_scope" };
    }
}

// Convert text to speech using ElevenLabs
export async function textToSpeech(text, voiceId = "21m00Tcm4TlvDq8ikWAM") {
    //using Default voice - "Rachel"

    const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: 'POST',
        headers: {
            'Accept': 'audio/mpeg',
            'Content-Type': 'application/json',
            'xi-api-key': ELEVENLABS_API_KEY
        },
        body: JSON.stringify({
            text: text,
            model_id: "eleven_monolingual_v1",
            voice_settings: {
                stability: 0.5,
                similarity_boost: 0.5
            }
        })
    });

    if (!resp.ok) {
        const txt = await resp.text();
        throw new Error("ElevenLabs TTS error: " + resp.status + " - " + txt);
    }

    // Get audio as array buffer
    const audioBuffer = await resp.arrayBuffer();
    const audioBase64 = Buffer.from(audioBuffer).toString('base64');

    return { audioBase64, contentType: "audio/mpeg" };
}

/**
 * Voice-to-Voice conversation using ElevenLabs
 */
export async function voiceToVoice(audioBase64, systemPrompt = null) {
    try {
        // First, convert audio to text using ElevenLabs
        const transcription = await speechToText(audioBase64);

        if (!transcription) {
            throw new Error("No transcription returned");
        }

        // Generate a text response using Gemini
        const responseUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GOOGLE_KEY}`;

        let responsePrompt = transcription;
        if (systemPrompt) {
            responsePrompt = `${systemPrompt}\n\nUser: ${transcription}\n\nAssistant:`;
        }

        const responseBody = {
            contents: [{ parts: [{ text: responsePrompt }] }],
            generationConfig: {
                temperature: 0.7,
                maxOutputTokens: 1000
            }
        };

        const responseResp = await fetch(responseUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(responseBody)
        });

        if (!responseResp.ok) {
            const txt = await responseResp.text();
            throw new Error("Text response error: " + responseResp.status + " - " + txt);
        }

        const responseJson = await responseResp.json();
        const responseText = responseJson?.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!responseText) {
            throw new Error("No text response generated");
        }

        // Finally, convert the response to speech using ElevenLabs
        const ttsResult = await textToSpeech(responseText);

        return {
            audioBase64: ttsResult.audioBase64,
            contentType: ttsResult.contentType,
            text: responseText,
            transcription: transcription
        };

    } catch (error) {
        console.error("Voice-to-Voice error:", error);
        throw error;
    }
}

/*
 Voice-to-Voice with hospital search context
 Specialized version for your hospital assistant
 */
export async function hospitalVoiceAssistant(audioBase64, hospitalData = null) {
    const systemPrompt = `You are "Loop AI", a helpful voice assistant for finding hospitals. 
You help users search for hospitals by city or name. 
Be conversational and natural in your speech.
Keep responses concise but friendly.
${hospitalData ? `Here's relevant hospital information: ${JSON.stringify(hospitalData)}` : ''}`;

    return await voiceToVoice(audioBase64, systemPrompt);
}

// Get available voices from ElevenLabs
export async function getAvailableVoices() {
    const resp = await fetch('https://api.elevenlabs.io/v1/voices', {
        method: 'GET',
        headers: {
            'xi-api-key': ELEVENLABS_API_KEY
        }
    });

    if (!resp.ok) {
        const txt = await resp.text();
        throw new Error("Failed to get voices: " + resp.status + " - " + txt);
    }

    return await resp.json();
}

// Legacy functions for compatibility (now using ElevenLabs)
export async function textToSpeechPro(text, voiceId = "21m00Tcm4TlvDq8ikWAM") {
    return await textToSpeech(text, voiceId);
}