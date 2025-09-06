# Loop AI Hospital Network Assistant

This repository contains the source code for a voice and text-enabled AI assistant designed to help users query a network of hospitals. The application leverages modern AI services for natural language understanding, vector search, and speech synthesis to provide a seamless user experience.

The project is built with a React frontend and a Node.js/Express backend, integrated with Google Gemini for intent parsing and embeddings, Qdrant for efficient vector search, and ElevenLabs for realistic text-to-speech conversion.

## Features

-   **Dual-Mode Interaction**: Supports both text-based and voice-based conversations.
-   **AI-Powered Intent Parsing**: Utilizes Google Gemini to understand user intent (e.g., search vs. confirmation) and extract key entities like city and hospital names.
-   **Semantic Hospital Search**: Finds hospitals based on natural language queries, such as "hospitals in New Delhi".
-   **Hospital Confirmation**: Verifies if a specific hospital is part of the network using a hybrid search approach that combines semantic and fuzzy matching.
-   **Voice-to-Voice Conversation**: Provides a complete voice-driven experience by converting user speech to text, generating a response, and converting that response back to speech.
-   **Efficient Data Ingestion**: Includes a robust script to process a CSV file of hospitals, generate vector embeddings, and ingest them into a Qdrant database, with duplicate detection and batch processing.

## Architecture

The application is structured into a separate frontend and backend.

### Frontend

-   Built with **React** and **Vite**.
-   Handles user input via text fields or microphone (using the Web Speech API and MediaRecorder API).
-   Communicates with the backend via RESTful API calls.
-   Renders the conversation history and search results.
-   Plays back the audio responses synthesized by the backend.

### Backend

-   Built with **Node.js** and **Express**.
-   **`genaiClient.js`**: A client module for interacting with external AI services.
    -   **Google Gemini**: Used for generating text embeddings (`text-embedding-004`), speech-to-text transcription, and structured intent parsing (`gemini-2.5-flash`).
    -   **ElevenLabs**: Used for high-quality text-to-speech (TTS) conversion.
-   **`qdrantClient.js`**: Manages all interactions with the Qdrant vector database, including collection creation, indexing, and executing vector and hybrid searches.
-   **`ingestCSV.js`**: A standalone script to populate the Qdrant database. It reads `hospitals_sample.csv`, deduplicates entries, generates embeddings in batches, and upserts the data.
-   **API Routes**:
    -   `/api/chat`: Handles text-based interactions.
    -   `/api/voice-chat`: Manages voice-based interactions.
    -   `/api/search`: Provides a direct endpoint for hospital searches.

## Getting Started

Follow these instructions to set up and run the project locally.

### Prerequisites

-   [Node.js](https://nodejs.org/) (v16 or higher)
-   [npm](https://www.npmjs.com/) (comes with Node.js)
-   Access to a [Qdrant](https://qdrant.tech/) instance (cloud or local).
-   API keys for Google AI and ElevenLabs.

### Environment Variables

Before starting, create a `.env` file in the `backend/` directory. Copy the contents of `.env.example` (if provided) or add the following variables:

```env
# Google AI API Key for Gemini and Embeddings
GOOGLE_API_KEY="YOUR_GOOGLE_API_KEY"

# ElevenLabs API Key for Text-to-Speech
ELEVENLABS_API_KEY="YOUR_ELEVENLABS_API_KEY"

# Qdrant Vector Database URL and optional API Key
QDRANT_URL="YOUR_QDRANT_INSTANCE_URL"
QDRANT_API_KEY="YOUR_QDRANT_API_KEY" # Optional

# Twilio (Optional - for out-of-scope request notifications)
TWILIO_ACCOUNT_SID="YOUR_TWILIO_SID"
TWILIO_AUTH_TOKEN="YOUR_TWILIO_TOKEN"
TWILIO_FROM_NUMBER="+1..."
TWILIO_NOTIFY_NUMBER="+1..."
```

### Backend Setup

1.  **Navigate to the backend directory:**
    ```sh
    cd backend
    ```

2.  **Install dependencies:**
    ```sh
    npm install
    ```

3.  **Run the data ingestion script:**
    This will read the `hospitals_sample.csv` file, generate vector embeddings for each hospital, and store them in your Qdrant instance.
    ```sh
    npm run ingest
    ```

4.  **Start the backend server:**
    The server will run on `http://localhost:4000`.
    ```sh
    npm run dev
    ```

### Frontend Setup

1.  **Navigate to the frontend directory:**
    ```sh
    cd frontend
    ```

2.  **Install dependencies:**
    ```sh
    npm install
    ```

3.  **Start the frontend development server:**
    The application will be available at `http://localhost:5173`.
    ```sh
    npm run dev
    ```

You can now open your browser and interact with the AI assistant.

## API Endpoints

The backend server exposes the following API endpoints:

-   `POST /api/chat`
    -   Handles text-based chat interactions.
    -   **Body**: `{ "sessionId": "string", "text": "string" }`
    -   **Returns**: `{ "reply": "string", "audioBase64": "string", "contentType": "string", "items": [...] }`

-   `POST /api/voice-chat`
    -   Handles voice-based interactions.
    -   **Body**: `{ "sessionId": "string", "audioBase64": "string" }`
    -   **Returns**: `{ "reply": "string", "audioBase64": "string", "contentType": "string", "items": [...] }`

-   `POST /api/search`
    -   Performs a direct vector search for hospitals.
    -   **Body**: `{ "q": "string", "city": "string" (optional), "limit": number (optional) }`

-   `GET /health`
    -   Provides a health check of the backend service and its environment configuration.
