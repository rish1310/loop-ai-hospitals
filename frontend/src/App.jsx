import React, { useState, useRef, useEffect } from "react";
import { v4 as uuidv4 } from "uuid";

const SERVER = import.meta.env.VITE_API_BASE || "http://localhost:4000";

export default function App() {
    const [listening, setListening] = useState(false);
    const [recording, setRecording] = useState(false);
    const [text, setText] = useState("");
    const [reply, setReply] = useState("");
    const [items, setItems] = useState([]);
    const [mode, setMode] = useState("voice");
    const [loading, setLoading] = useState(false);
    const [conversation, setConversation] = useState([]);

    const recognitionRef = useRef(null);
    const mediaRecorderRef = useRef(null);
    const audioChunksRef = useRef([]);
    const sessionIdRef = useRef(uuidv4());

    useEffect(() => {
        // Add initial greeting to conversation
        setConversation([{
            role: "assistant",
            message: "Hello! I'm Loop AI, your hospital network assistant. How can I help you today?",
            timestamp: new Date()
        }]);
    }, []);

    // Text mode with Web Speech Recognition
    const startListening = () => {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) {
            alert("Web Speech API not supported in this browser. Please use Chrome or Edge.");
            return;
        }

        const rec = new SpeechRecognition();
        rec.lang = "en-IN";
        rec.interimResults = false;
        rec.continuous = false;

        rec.onresult = (ev) => {
            const transcript = ev.results[0][0].transcript;
            setText(transcript);
            addToConversation("user", transcript);
            sendTextToServer(transcript);
        };

        rec.onerror = (e) => {
            console.error("Speech recognition error:", e);
            setListening(false);
        };

        rec.onend = () => setListening(false);

        recognitionRef.current = rec;
        rec.start();
        setListening(true);
    };

    const stopListening = () => {
        if (recognitionRef.current) {
            recognitionRef.current.stop();
        }
        setListening(false);
    };

    // Voice-to-Voice mode with MediaRecorder
    const startRecording = async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    sampleRate: 16000,
                    channelCount: 1,
                    echoCancellation: true,
                    noiseSuppression: true
                }
            });

            const mediaRecorder = new MediaRecorder(stream, {
                mimeType: 'audio/webm;codecs=opus'
            });

            audioChunksRef.current = [];

            mediaRecorder.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    audioChunksRef.current.push(event.data);
                }
            };

            mediaRecorder.onstop = () => {
                const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
                convertBlobToBase64(audioBlob);
                stream.getTracks().forEach(track => track.stop());
            };

            mediaRecorderRef.current = mediaRecorder;
            mediaRecorder.start();
            setRecording(true);

        } catch (err) {
            console.error("Error accessing microphone:", err);
            alert("Could not access microphone. Please check permissions.");
        }
    };

    const stopRecording = () => {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
            mediaRecorderRef.current.stop();
        }
        setRecording(false);
    };

    const convertBlobToBase64 = (blob) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            const base64 = reader.result.split(',')[1];
            addToConversation("user", "[Voice Message]");
            sendVoiceToServer(base64);
        };
        reader.readAsDataURL(blob);
    };

    const addToConversation = (role, message, items = null) => {
        setConversation(prev => [...prev, {
            role,
            message,
            items,
            timestamp: new Date()
        }]);
    };

    async function sendTextToServer(text) {
        setLoading(true);
        try {
            const res = await fetch(`${SERVER}/api/chat`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    sessionId: sessionIdRef.current,
                    text: text
                })
            });

            if (!res.ok) {
                throw new Error(`Server error: ${res.status}`);
            }

            const data = await res.json();
            setReply(data.reply);
            setItems(data.items || []);

            addToConversation("assistant", data.reply, data.items);

            // Play audio response if available
            if (data.audioBase64) {
                playAudioResponse(data.audioBase64);
            }

        } catch (err) {
            console.error("Error:", err);
            const errorMsg = "Sorry, I'm having trouble connecting to the server. Please try again.";
            setReply(errorMsg);
            addToConversation("assistant", errorMsg);
        } finally {
            setLoading(false);
        }
    }

    async function sendVoiceToServer(audioBase64) {
        setLoading(true);
        try {
            const res = await fetch(`${SERVER}/api/voice-chat`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    sessionId: sessionIdRef.current,
                    audioBase64: audioBase64
                })
            });

            if (!res.ok) {
                throw new Error(`Server error: ${res.status}`);
            }

            const data = await res.json();
            setReply(data.reply);
            setItems(data.items || []);

            addToConversation("assistant", data.reply, data.items);

            // Play audio response
            if (data.audioBase64) {
                playAudioResponse(data.audioBase64);
            }

        } catch (err) {
            console.error("Voice chat error:", err);
            const errorMsg = "Sorry, I couldn't process your voice message. Please try again.";
            setReply(errorMsg);
            addToConversation("assistant", errorMsg);
        } finally {
            setLoading(false);
        }
    }

    const playAudioResponse = (audioBase64, contentType = "audio/mpeg") => {
        try {
            // Handle different audio formats from different services
            const mimeType = contentType === "audio/wav" ? "audio/wav" : "audio/mpeg";
            const audio = new Audio(`data:${mimeType};base64,${audioBase64}`);

            audio.play().catch(err => {
                console.error("Error playing audio:", err);
                // Fallback: try with different mime type
                if (mimeType === "audio/mpeg") {
                    const fallbackAudio = new Audio(`data:audio/wav;base64,${audioBase64}`);
                    fallbackAudio.play().catch(fallbackErr => {
                        console.error("Fallback audio play failed:", fallbackErr);
                    });
                }
            });
        } catch (err) {
            console.error("Error creating audio element:", err);
        }
    };

    // Update the sendTextToServer function call to playAudioResponse
    async function sendTextToServer(text) {
        setLoading(true);
        try {
            const res = await fetch(`${SERVER}/api/chat`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    sessionId: sessionIdRef.current,
                    text: text
                })
            });

            if (!res.ok) {
                throw new Error(`Server error: ${res.status}`);
            }

            const data = await res.json();
            setReply(data.reply);
            setItems(data.items || []);

            addToConversation("assistant", data.reply, data.items);

            // Play audio response if available - pass contentType from response
            if (data.audioBase64) {
                playAudioResponse(data.audioBase64, data.contentType);
            }

        } catch (err) {
            console.error("Error:", err);
            const errorMsg = "Sorry, I'm having trouble connecting to the server. Please try again.";
            setReply(errorMsg);
            addToConversation("assistant", errorMsg);
        } finally {
            setLoading(false);
        }
    }

    // Update the sendVoiceToServer function call to playAudioResponse
    async function sendVoiceToServer(audioBase64) {
        setLoading(true);
        try {
            const res = await fetch(`${SERVER}/api/voice-chat`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    sessionId: sessionIdRef.current,
                    audioBase64: audioBase64
                })
            });

            if (!res.ok) {
                throw new Error(`Server error: ${res.status}`);
            }

            const data = await res.json();
            setReply(data.reply);
            setItems(data.items || []);

            addToConversation("assistant", data.reply, data.items);

            // Play audio response - pass contentType from response
            if (data.audioBase64) {
                playAudioResponse(data.audioBase64, data.contentType);
            }

        } catch (err) {
            console.error("Voice chat error:", err);
            const errorMsg = "Sorry, I couldn't process your voice message. Please try again.";
            setReply(errorMsg);
            addToConversation("assistant", errorMsg);
        } finally {
            setLoading(false);
        }
    }

    const handleTextSubmit = (e) => {
        e.preventDefault();
        if (text.trim()) {
            addToConversation("user", text);
            sendTextToServer(text);
            setText("");
        }
    };

    const clearConversation = () => {
        setConversation([{
            role: "assistant",
            message: "Hello! I'm Loop AI, your hospital network assistant. How can I help you today?",
            timestamp: new Date()
        }]);
        sessionIdRef.current = uuidv4();
        setReply("");
        setItems([]);
        setText("");
    };

    return (
        <div style={{
            minHeight: "100vh",
            background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
            padding: "20px",
            fontFamily: "'Segoe UI', Tahoma, Geneva, Verdana, sans-serif"
        }}>
            <div style={{
                maxWidth: "800px",
                margin: "0 auto",
                backgroundColor: "white",
                borderRadius: "20px",
                padding: "30px",
                boxShadow: "0 20px 40px rgba(0,0,0,0.1)"
            }}>

                {/* Header */}
                <div style={{ textAlign: "center", marginBottom: "30px" }}>
                    <h1 style={{
                        color: "#333",
                        margin: "0 0 10px 0",
                        fontSize: "2.5em",
                        fontWeight: "300"
                    }}>
                        🏥 Loop AI
                    </h1>
                    <p style={{ color: "#666", margin: 0, fontSize: "1.1em" }}>
                        Hospital Network Assistant
                    </p>
                </div>

                {/* Mode Selector */}
                <div style={{
                    display: "flex",
                    justifyContent: "center",
                    marginBottom: "20px",
                    gap: "10px"
                }}>
                    <button
                        onClick={() => setMode("text")}
                        style={{
                            padding: "10px 20px",
                            borderRadius: "25px",
                            border: "2px solid #667eea",
                            backgroundColor: mode === "text" ? "#667eea" : "transparent",
                            color: mode === "text" ? "white" : "#667eea",
                            cursor: "pointer",
                            fontSize: "14px",
                            fontWeight: "500",
                            transition: "all 0.3s ease"
                        }}
                    >
                        💬 Text Mode
                    </button>
                    <button
                        onClick={() => setMode("voice")}
                        style={{
                            padding: "10px 20px",
                            borderRadius: "25px",
                            border: "2px solid #667eea",
                            backgroundColor: mode === "voice" ? "#667eea" : "transparent",
                            color: mode === "voice" ? "white" : "#667eea",
                            cursor: "pointer",
                            fontSize: "14px",
                            fontWeight: "500",
                            transition: "all 0.3s ease"
                        }}
                    >
                        🎤 Voice Mode
                    </button>
                    <button
                        onClick={clearConversation}
                        style={{
                            padding: "10px 20px",
                            borderRadius: "25px",
                            border: "2px solid #e74c3c",
                            backgroundColor: "transparent",
                            color: "#e74c3c",
                            cursor: "pointer",
                            fontSize: "14px",
                            fontWeight: "500",
                            transition: "all 0.3s ease"
                        }}
                    >
                        🗑️ Clear
                    </button>
                </div>

                {/* Input Section */}
                {mode === "text" ? (
                    <div style={{ marginBottom: "30px" }}>
                        <form onSubmit={handleTextSubmit} style={{ display: "flex", gap: "10px" }}>
                            <input
                                type="text"
                                value={text}
                                onChange={(e) => setText(e.target.value)}
                                placeholder="Type your message or click the microphone..."
                                style={{
                                    flex: 1,
                                    padding: "15px",
                                    borderRadius: "25px",
                                    border: "2px solid #e1e8ed",
                                    fontSize: "16px",
                                    outline: "none",
                                    transition: "border-color 0.3s ease"
                                }}
                                onFocus={(e) => e.target.style.borderColor = "#667eea"}
                                onBlur={(e) => e.target.style.borderColor = "#e1e8ed"}
                            />
                            <button
                                type="button"
                                onClick={listening ? stopListening : startListening}
                                disabled={loading}
                                style={{
                                    padding: "15px 20px",
                                    borderRadius: "50%",
                                    border: "none",
                                    backgroundColor: listening ? "#e74c3c" : "#667eea",
                                    color: "white",
                                    cursor: loading ? "not-allowed" : "pointer",
                                    fontSize: "18px",
                                    transition: "all 0.3s ease",
                                    minWidth: "50px"
                                }}
                            >
                                {listening ? "🛑" : "🎤"}
                            </button>
                            <button
                                type="submit"
                                disabled={!text.trim() || loading}
                                style={{
                                    padding: "15px 25px",
                                    borderRadius: "25px",
                                    border: "none",
                                    backgroundColor: "#28a745",
                                    color: "white",
                                    cursor: (!text.trim() || loading) ? "not-allowed" : "pointer",
                                    fontSize: "16px",
                                    transition: "all 0.3s ease"
                                }}
                            >
                                Send
                            </button>
                        </form>
                    </div>
                ) : (
                    <div style={{ textAlign: "center", marginBottom: "30px" }}>
                        <button
                            onClick={recording ? stopRecording : startRecording}
                            disabled={loading}
                            style={{
                                padding: "20px",
                                borderRadius: "50%",
                                border: "none",
                                backgroundColor: recording ? "#e74c3c" : "#667eea",
                                color: "white",
                                cursor: loading ? "not-allowed" : "pointer",
                                fontSize: "24px",
                                transition: "all 0.3s ease",
                                width: "80px",
                                height: "80px",
                                boxShadow: recording ? "0 0 20px rgba(231, 76, 60, 0.5)" : "0 0 20px rgba(102, 126, 234, 0.3)"
                            }}
                        >
                            {recording ? "🛑" : "🎤"}
                        </button>
                        <p style={{ marginTop: "15px", color: "#666" }}>
                            {recording ? "Recording... Click to stop" : "Click to start voice conversation"}
                        </p>
                    </div>
                )}

                {/* Loading Indicator */}
                {loading && (
                    <div style={{ textAlign: "center", margin: "20px 0" }}>
                        <div style={{
                            display: "inline-block",
                            width: "20px",
                            height: "20px",
                            border: "3px solid #f3f3f3",
                            borderTop: "3px solid #667eea",
                            borderRadius: "50%",
                            animation: "spin 1s linear infinite"
                        }}></div>
                        <p style={{ color: "#666", margin: "10px 0 0 0" }}>
                            Processing...
                        </p>
                    </div>
                )}

                {/* Conversation History */}
                <div style={{
                    maxHeight: "400px",
                    overflowY: "auto",
                    backgroundColor: "#f8f9fa",
                    borderRadius: "15px",
                    padding: "20px",
                    marginBottom: "20px"
                }}>
                    {conversation.map((msg, idx) => (
                        <div key={idx} style={{
                            marginBottom: "15px",
                            display: "flex",
                            justifyContent: msg.role === "user" ? "flex-end" : "flex-start"
                        }}>
                            <div style={{
                                maxWidth: "70%",
                                padding: "12px 16px",
                                borderRadius: "18px",
                                backgroundColor: msg.role === "user" ? "#667eea" : "white",
                                color: msg.role === "user" ? "white" : "#333",
                                boxShadow: "0 2px 8px rgba(0,0,0,0.1)",
                                fontSize: "14px",
                                lineHeight: "1.4"
                            }}>
                                <div style={{ fontWeight: "500", marginBottom: msg.items ? "8px" : "0" }}>
                                    {msg.message}
                                </div>
                                {msg.items && msg.items.length > 0 && (
                                    <div style={{
                                        marginTop: "10px",
                                        padding: "10px",
                                        backgroundColor: "#f0f0f0",
                                        borderRadius: "8px",
                                        fontSize: "13px"
                                    }}>
                                        {msg.items
                                            .filter(item => item && item.name && item.address) // ✅ only render valid items
                                            .map((item, itemIdx) => (
                                                <div key={itemIdx} style={{
                                                    marginBottom: "8px",
                                                    paddingBottom: "8px",
                                                    borderBottom: itemIdx < msg.items.length - 1 ? "1px solid #ddd" : "none"
                                                }}>
                                                    <strong style={{ color: "#2c3e50" }}>{item.name}</strong><br />
                                                    <small style={{ color: "#666" }}>{item.address}, {item.city}</small>
                                                    {item.score && (
                                                        <small style={{ color: "#888", display: "block", fontSize: "11px" }}>
                                                            Relevance: {(item.score * 100).toFixed(1)}%
                                                        </small>
                                                    )}
                                                </div>
                                            ))}
                                    </div>
                                )}

                            </div>
                        </div>
                    ))}
                </div>

                {/* Quick Actions */}
                <div style={{
                    display: "flex",
                    gap: "10px",
                    flexWrap: "wrap",
                    justifyContent: "center"
                }}>
                    <button
                        onClick={() => {
                            const query = "Tell me 3 hospitals around Bangalore";
                            if (mode === "text") {
                                setText(query);
                                addToConversation("user", query);
                                sendTextToServer(query);
                            }
                        }}
                        style={{
                            padding: "8px 15px",
                            borderRadius: "20px",
                            border: "1px solid #ddd",
                            backgroundColor: "white",
                            color: "#666",
                            cursor: "pointer",
                            fontSize: "12px",
                            transition: "all 0.3s ease"
                        }}
                        onMouseOver={(e) => {
                            e.target.style.backgroundColor = "#f0f0f0";
                        }}
                        onMouseOut={(e) => {
                            e.target.style.backgroundColor = "white";
                        }}
                    >
                        Find hospitals in Bangalore
                    </button>
                    <button
                        onClick={() => {
                            const query = "Can you confirm if Apollo Hospital Delhi is in my network?";
                            if (mode === "text") {
                                setText(query);
                                addToConversation("user", query);
                                sendTextToServer(query);
                            }
                        }}
                        style={{
                            padding: "8px 15px",
                            borderRadius: "20px",
                            border: "1px solid #ddd",
                            backgroundColor: "white",
                            color: "#666",
                            cursor: "pointer",
                            fontSize: "12px",
                            transition: "all 0.3s ease"
                        }}
                        onMouseOver={(e) => {
                            e.target.style.backgroundColor = "#f0f0f0";
                        }}
                        onMouseOut={(e) => {
                            e.target.style.backgroundColor = "white";
                        }}
                    >
                        Check network status
                    </button>
                </div>
            </div>

            {/* CSS Animation */}
            <style>{`
                @keyframes spin {
                    0% { transform: rotate(0deg); }
                    100% { transform: rotate(360deg); }
                }
            `}</style>
        </div>
    );
}