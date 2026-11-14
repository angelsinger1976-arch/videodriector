import "dotenv/config";
import express from "express";
import path from "path";
import { GoogleGenAI, Type } from "@google/genai";
import { DIRECTORS } from "./src/data/compendium.ts";

interface ReferenceImage {
  data: string;
  mimeType: string;
}

interface DirectorInput {
  id?: string;
  name: string;
  description: string;
  prompt: string;
  params: string;
}

function getAI() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is missing on the server. Please configure it in Settings > Secrets.");
  }

  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

let lastImageRequestTime = 0;
let imageQueue: Promise<unknown> = Promise.resolve();
const MIN_IMAGE_INTERVAL_MS = 3500;

function enqueueImageRequest<T>(fn: () => Promise<T>): Promise<T> {
  const next = imageQueue.then(async () => {
    const now = Date.now();
    const waitMs = Math.max(0, lastImageRequestTime + MIN_IMAGE_INTERVAL_MS - now);
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    lastImageRequestTime = Date.now();
    return fn();
  });
  imageQueue = next.catch(() => {});
  return next;
}

function isNonRetryableQuotaError(message: string): boolean {
  return (
    message.includes("limit: 0") ||
    message.includes("GenerateRequestsPerDay") ||
    message.includes("billing")
  );
}

function parseRetryDelayMs(message: string, fallbackMs: number): number {
  const match = message.match(/retry in (\d+(?:\.\d+)?)s/i);
  if (match) {
    const parsedMs = Math.ceil(parseFloat(match[1]) * 1000) + 500;
    return Math.min(Math.max(parsedMs, 1000), 30000);
  }
  return fallbackMs;
}

async function withRetry<T>(fn: () => Promise<T>, retries = 2, delay = 4000): Promise<T> {
  try {
    return await fn();
  } catch (error: any) {
    const message = error?.message || "";
    const status = error?.status;
    const isTransient =
      status === 429 ||
      status === 503 ||
      message.includes("429") ||
      message.includes("RESOURCE_EXHAUSTED") ||
      message.includes("UNAVAILABLE");

    if (isTransient && !isNonRetryableQuotaError(message) && retries > 0) {
      const waitMs = parseRetryDelayMs(message, delay);
      console.info(`Gemini API rate limit (${status || "transient"}). Waiting ${waitMs}ms before retry (${retries} left)...`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return withRetry(fn, retries - 1, delay * 2);
    }
    throw error;
  }
}

function formatErrorResponse(error: any) {
  const rawMessage = error?.message || "An unexpected server error occurred.";
  let statusCode =
    typeof error?.status === "number" && error.status >= 400 && error.status < 600
      ? error.status
      : 500;

  if (rawMessage.includes("RESOURCE_EXHAUSTED") || rawMessage.includes("429")) {
    statusCode = 429;
  } else if (
    rawMessage.includes("API_KEY_INVALID") ||
    rawMessage.includes("PERMISSION_DENIED") ||
    rawMessage.includes("403")
  ) {
    statusCode = 403;
  }

  let friendlyMessage = rawMessage;
  if (statusCode === 403) {
    if (rawMessage.includes("free tier is not available") || rawMessage.includes("billing")) {
      friendlyMessage =
        "The Gemini API free tier is not available for this project. Please select a billing-enabled API key in the paid key prompt or under Settings > Secrets.";
    } else {
      friendlyMessage =
        "Invalid or unauthorized Gemini API key (403). Please check or select a valid GEMINI_API_KEY in Settings > Secrets.";
    }
  } else if (statusCode === 429) {
    friendlyMessage =
      "Gemini API rate limit or quota exceeded (429). Upgrading to a paid tier key in Settings > Secrets increases your quota for text and image generation.";
  }

  return { statusCode, message: friendlyMessage };
}

const IMAGE_MODEL = "gemini-3.1-flash-lite-image";
const TEXT_MODEL = "gemini-4-hydrogen";
const TRANSCRIBE_MODEL = "gemini-3.5-transcribe";
const COSMOS3_NANO_URL =
  process.env.NVIDIA_COSMOS_URL || "https://ai.api.nvidia.com/v1/cosmos/nvidia/cosmos3-nano";
const NVIDIA_FLUX_FALLBACK_URL =
  "https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.1-schnell";
const NVIDIA_CHAT_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const NVIDIA_VL_MODEL = "nvidia/nemotron-3.5-super-vl-120b-a12b";
const NVIDIA_OMNI_MODEL = "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning";

function getNvidiaApiKey(): string | undefined {
  return process.env.NVIDIA_API_KEY;
}

function extractJsonObject(raw: string): any {
  const trimmed = raw.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenceMatch ? fenceMatch[1].trim() : trimmed;
  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
  }
  return JSON.parse(candidate);
}

async function transcribeWithNvidiaOmni(audioBase64: string, mimeType: string): Promise<string | null> {
  const nvidiaKey = getNvidiaApiKey();
  if (!nvidiaKey) return null;

  const cleanMime = mimeType || "audio/mp3";
  const response = await fetch(NVIDIA_CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${nvidiaKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: NVIDIA_OMNI_MODEL,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "audio_url",
              audio_url: {
                url: `data:${cleanMime};base64,${audioBase64}`,
              },
            },
            {
              type: "text",
              text: "Transcribe the lyrics of this song accurately. If there are no lyrics, describe the musical style and mood in detail. Return only the transcription or description.",
            },
          ],
        },
      ],
      temperature: 0.2,
      max_tokens: 1500,
      chat_template_kwargs: { enable_thinking: false },
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`NVIDIA Omni transcription failed (${response.status}): ${errText.slice(0, 200)}`);
  }

  const data = (await response.json()) as {
    choices?: { message?: { content?: string | null } }[];
  };
  return data.choices?.[0]?.message?.content?.trim() || null;
}

async function generateJsonWithNvidiaNIM(
  systemInstruction: string,
  userPrompt: string,
  referenceImages?: ReferenceImage[]
): Promise<any> {
  const nvidiaKey = getNvidiaApiKey();
  if (!nvidiaKey) {
    throw new Error("NVIDIA_API_KEY is not configured.");
  }

  const userContent: any[] = [];
  if (referenceImages && referenceImages.length > 0) {
    referenceImages.forEach((img, idx) => {
      userContent.push({
        type: "image_url",
        image_url: {
          url: `data:${img.mimeType || "image/jpeg"};base64,${img.data}`,
        },
      });
      userContent.push({
        type: "text",
        text: `Artist reference image #${idx + 1}. Analyze the physical appearance (features, hair, build) of the person in this image.`,
      });
    });
  }
  userContent.push({
    type: "text",
    text: userPrompt,
  });

  const response = await fetch(NVIDIA_CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${nvidiaKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: NVIDIA_VL_MODEL,
      messages: [
        {
          role: "system",
          content: `${systemInstruction}\n\nIMPORTANT: Return ONLY a single valid JSON object. Do not wrap in markdown code fences or add explanatory text.`,
        },
        {
          role: "user",
          content: userContent.length === 1 ? userPrompt : userContent,
        },
      ],
      temperature: 0.3,
      max_tokens: 8192,
      chat_template_kwargs: { enable_thinking: false },
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`NVIDIA NIM generation failed (${response.status}): ${errText.slice(0, 200)}`);
  }

  const data = (await response.json()) as {
    choices?: { message?: { content?: string | null } }[];
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("Empty response from NVIDIA NIM.");
  }

  return extractJsonObject(content);
}

function mapAspectRatioToCosmosResolution(aspectRatio: string = "16:9", tier: "480" | "720" = "720"): string {
  const normalized = aspectRatio.replace(":", "_");
  const validSuffixes = ["16_9", "1_1", "9_16", "4_3", "3_4"];
  const suffix = validSuffixes.includes(normalized) ? normalized : "1_1";
  return `${tier}_${suffix}`;
}

function mapAspectRatioToDimensions(aspectRatio: string = "16:9"): { width: number; height: number } {
  switch (aspectRatio) {
    case "16:9":
      return { width: 1344, height: 768 };
    case "9:16":
      return { width: 768, height: 1344 };
    case "4:3":
      return { width: 1152, height: 896 };
    case "3:4":
      return { width: 896, height: 1152 };
    case "1:1":
    default:
      return { width: 1024, height: 1024 };
  }
}

async function generateImageWithCosmos3Nano(
  prompt: string,
  aspectRatio: string = "1:1"
): Promise<{ base64: string; mimeType: string; dataUrl: string } | null> {
  const nvidiaKey = getNvidiaApiKey();
  if (!nvidiaKey) {
    return null;
  }

  const resolution = mapAspectRatioToCosmosResolution(aspectRatio, "720");
  const cleanPrompt = prompt.trim();

  // 1. Primary request: NVIDIA Cosmos 3 Nano (POST https://ai.api.nvidia.com/v1/cosmos/nvidia/cosmos3-nano)
  try {
    const cosmosResponse = await fetch(COSMOS3_NANO_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${nvidiaKey}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model_mode: "text2image",
        prompt: cleanPrompt,
        resolution,
        num_inference_steps: 50,
        guidance_scale: 4,
        seed: Math.floor(Math.random() * 1000000),
      }),
      signal: AbortSignal.timeout(25000),
    });

    if (cosmosResponse.ok) {
      const data = (await cosmosResponse.json()) as {
        b64_image?: string | null;
        artifacts?: { base64?: string }[];
      };
      const b64 = data.b64_image || data.artifacts?.[0]?.base64;
      if (b64) {
        const mimeType = "image/jpeg";
        return {
          base64: b64,
          mimeType,
          dataUrl: `data:${mimeType};base64,${b64}`,
        };
      }
    } else {
      const errText = await cosmosResponse.text().catch(() => "");
      console.warn(
        `NVIDIA Cosmos 3 Nano (${COSMOS3_NANO_URL}) returned ${cosmosResponse.status}: ${errText.slice(0, 200)}`
      );

      // If Cosmos 3 Nano hosted endpoint returns 404/410 on trial gateway, try NVIDIA NIM GenAI Flux fallback with the same NVIDIA_API_KEY
      if (cosmosResponse.status === 404 || cosmosResponse.status === 410) {
        const { width, height } = mapAspectRatioToDimensions(aspectRatio);
        const fluxRes = await fetch(NVIDIA_FLUX_FALLBACK_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${nvidiaKey}`,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            prompt: cleanPrompt,
            width,
            height,
            seed: 0,
            steps: 4,
          }),
          signal: AbortSignal.timeout(25000),
        });

        if (fluxRes.ok) {
          const fluxData = (await fluxRes.json()) as {
            artifacts?: { base64?: string }[];
            b64_image?: string;
          };
          const b64 = fluxData.artifacts?.[0]?.base64 || fluxData.b64_image;
          if (b64) {
            const mimeType = "image/jpeg";
            return {
              base64: b64,
              mimeType,
              dataUrl: `data:${mimeType};base64,${b64}`,
            };
          }
        }
      } else if (cosmosResponse.status === 401 || cosmosResponse.status === 403 || cosmosResponse.status === 422) {
        const err: any = new Error(
          `NVIDIA Cosmos 3 Nano error (${cosmosResponse.status}): ${errText || "Check NVIDIA_API_KEY in Settings > Secrets."}`
        );
        err.status = cosmosResponse.status === 422 ? 400 : 403;
        throw err;
      }
    }
  } catch (err: any) {
    if (err?.status === 400 || err?.status === 403) {
      throw err;
    }
    console.warn("NVIDIA image generation notice:", err?.message || err);
  }

  return null;
}

async function startServer() {
  const app = express();
  const port = Number(process.env.PORT) || 3000;

  app.use(express.json({ limit: "50mb" }));

  // Transcribe audio
  app.post("/api/gemini/transcribe", async (req, res) => {
    try {
      const { audioBase64, mimeType } = req.body as { audioBase64?: string; mimeType?: string };
      if (!audioBase64 || !mimeType) {
        return res.status(400).json({ error: "Missing audioBase64 or mimeType." });
      }

      try {
        const ai = getAI();
        const response = await withRetry(() =>
          ai.models.generateContent({
            model: TRANSCRIBE_MODEL,
            contents: {
              parts: [
                {
                  inlineData: {
                    data: audioBase64,
                    mimeType,
                  },
                },
                {
                  text: "Transcribe the lyrics of this song accurately. If there are no lyrics, describe the musical style and mood in detail. Return only the transcription or description.",
                },
              ],
            },
          })
        );

        return res.json({ text: response.text ?? null });
      } catch (geminiErr: any) {
        if (getNvidiaApiKey()) {
          console.info("Falling back to NVIDIA Nemotron Omni for audio transcription...");
          const text = await transcribeWithNvidiaOmni(audioBase64, mimeType);
          return res.json({ text });
        }
        throw geminiErr;
      }
    } catch (error: any) {
      const { statusCode, message } = formatErrorResponse(error);
      console.warn(`Transcription API error (${statusCode}): ${message}`);
      return res.status(statusCode).json({ error: message });
    }
  });

  // Generate storyboard
  app.post("/api/gemini/storyboard", async (req, res) => {
    try {
      const {
        songDescription,
        videoConcept,
        numCharacters,
        directorId,
        videoType,
        durationSeconds,
        referenceImages,
        customDirector,
      } = req.body as {
        songDescription: string;
        videoConcept: string;
        numCharacters: number;
        directorId: string;
        videoType: string;
        durationSeconds: number;
        referenceImages?: ReferenceImage[];
        customDirector?: DirectorInput;
      };

      const director = DIRECTORS.find((d) => d.id === directorId) || customDirector;
      const numClips = Math.ceil((durationSeconds || 32) / 8);

      const systemInstruction = `You are an elite AI Music Video Director. Your job is to create a highly technical Creative Brief and Shot List for a music video production. This will be used as a master reference for manual video creation.

CRITICAL RULES:
1. Each scene in the Shot List MUST represent exactly 8 seconds of the song.
2. You must generate exactly ${numClips} scenes to cover the total duration of ${durationSeconds} seconds.
3. The output must be a JSON object containing a "creativeBrief" and a "shotList".
4. The "creativeBrief" must be extremely detailed, following the structure of a professional cinematic production:
   - Project Overview: Title, Target Audience, Rhythm Driver, Estimated Duration, and a powerful One-sentence Summary.
   - Creative Concept & Structure: Structure Type (e.g., Cinematic Linear), Core Drive (e.g., Lyric Thematic), and a detailed Content Outline by blocks.
    - Reference Assets (INGREDIENTS): Identify a DIVERSE set of assets. 
     * CATEGORIES: You must provide multiple assets within each of these 4 categories:
       - PERSONAJE: You MUST create exactly ${numCharacters} main characters (e.g., personaje_01, personaje_02, personaje_03). Master Face/Identity. Focus ONLY on the face and facial features (la pura cara).
       - PERSONAJES-VESTUARIO (personaje_01_vestuario_01, personaje_01_vestuario_02, etc.): Create MULTIPLE distinct outfits (at least 3-4 per character) to keep the video dynamic.
         - PROMPT RULE: MUST include the character wearing the outfit. "Full body shot of the character, centered, wearing the specific outfit, isolated on a pure white background, studio lighting, high resolution, maintaining the exact facial features and identity of the corresponding PERSONAJE".
       - LOCACION (locacion_01, locacion_02, etc.): Create MULTIPLE distinct locations (at least 3-4).
       - PROP (prop_01, prop_02, etc.): Relevant objects on white background.
     * GENERATION PROMPT (General): Detailed English prompt. ALWAYS include: "cinematic photography, hyper-realistic, 8k, highly detailed, masterwork, cinematic lighting, no plastic textures, super real, 35mm film grain".
   - Script and Sound: BGM Brief and suggestions for Lip-sync/Actions.
5. The "shotList" must contain detailed technical data for each 8-second segment.
6. LOCATION CHANGE RULE: You MUST change the LOCACION and its associated PROP approximately every 45 seconds (every 5-6 shots). This ensures visual progression.
7. VARIETY IS MANDATORY: You MUST rotate between the different PERSONAJES-VESTUARIO throughout the shot list. Do not repeat the same combination for the whole video.
8. EXTRAS & CROWDS: In the "imagePrompt" and "animationPrompt", if the location is a public space (e.g., club, street, beach, bar), you MUST include "extras", "crowds", or "background people" to make the scene feel populated and realistic.
9. Each shot in "shotList" MUST explicitly reference the combination of assets used:
   - MUST include the PERSONAJE (for identity).
   - MUST include the PERSONAJES-VESTUARIO (for the outfit).
   - MUST include the LOCACION (for the background).
   - MUST include the PROP (if applicable).
10. SCENE IMAGES: You are FORBIDDEN from generating images for the shots. You only provide the technical design and asset combinations.
11. AI Prompts (MANDATORY):
   - "imagePrompt": MUST be a detailed English prompt describing the scene composition using the asset IDs (e.g., (personaje_01_vestuario_01) in (locacion_02) holding (prop_01)). Include descriptions of extras/crowds if applicable.
   - "animationPrompt": Detailed English prompt for video generation.
12. Maintain a "Character Anchor" across all prompts to ensure consistency.
13. Apply the specific visual DNA of the chosen director: ${director?.name || "Cinematic Director"}.
14. AESTHETIC GOAL: Cinematic, realistic, gritty, and immersive. Avoid "plastic" or "AI-looking" smooth textures.
15. Language: Use Spanish for descriptions/narrative and English for AI Prompts.
16. UNIQUENESS: Analyze the provided lyrics AND the Video Concept deeply. Do NOT reuse concepts from previous generic videos. Every video must be a unique masterpiece tailored to the specific song.`;

      const userPromptText = `
Song Description/Lyrics: "${songDescription}"
Video Concept/Theme: "${videoConcept}"
Number of Main Characters: ${numCharacters}
Video Type: ${videoType}
Chosen Director: ${director?.name || "Custom Style"}
Director's Vibe: ${director?.description || ""}
Base Prompt: ${director?.prompt || ""} ${director?.params || ""}
Total Duration: ${durationSeconds} seconds.

Create the complete Creative Brief and Shot List in JSON format with exact top-level keys "creativeBrief" (containing "projectOverview" {title, targetAudience, rhythmDriver, estimatedDuration, summary}, "creativeConcept" {structureType, coreDrive, contentOutline: [{block, timeframe, strategy}]}, "referenceAssets": [{id, name, type: "personaje"|"personajes-vestuario"|"locacion"|"prop", description, generationPrompt}], "scriptAndSound": {bgmBrief}) and "shotList" ([{sceneNumber, shotNumber, timecode, caption, startFrame, actionCamera, endFrame, rhythm, overallStyle, narrativeFunction, lyrics, duration, transitionEntry, transitionExit, editingRhythm, imagePrompt, animationPrompt, assetReferences: string[]}]).`;

      try {
        const parts: any[] = [];
        if (referenceImages && referenceImages.length > 0) {
          referenceImages.forEach((img, index) => {
            parts.push({
              inlineData: {
                data: img.data,
                mimeType: img.mimeType,
              },
            });
            parts.push({
              text: `Artist reference image #${index + 1}. Analyze the physical appearance (features, hair, build) of the person in this image.`,
            });
          });
          parts.push({
            text: "Use these reference images to ensure character consistency in the storyboard. If there are multiple different people, treat them as different characters in the music video.",
          });
        }

        parts.push({
          text: userPromptText,
        });

        const ai = getAI();
        const response = await withRetry(() =>
          ai.models.generateContent({
            model: TEXT_MODEL,
            contents: { parts },
            config: {
              systemInstruction,
              responseMimeType: "application/json",
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  creativeBrief: {
                    type: Type.OBJECT,
                    properties: {
                      projectOverview: {
                        type: Type.OBJECT,
                        properties: {
                          title: { type: Type.STRING },
                          targetAudience: { type: Type.STRING },
                          rhythmDriver: { type: Type.STRING },
                          estimatedDuration: { type: Type.STRING },
                          summary: { type: Type.STRING },
                        },
                        required: ["title", "targetAudience", "rhythmDriver", "estimatedDuration", "summary"],
                      },
                      creativeConcept: {
                        type: Type.OBJECT,
                        properties: {
                          structureType: { type: Type.STRING },
                          coreDrive: { type: Type.STRING },
                          contentOutline: {
                            type: Type.ARRAY,
                            items: {
                              type: Type.OBJECT,
                              properties: {
                                block: { type: Type.STRING },
                                timeframe: { type: Type.STRING },
                                strategy: { type: Type.STRING },
                              },
                              required: ["block", "timeframe", "strategy"],
                            },
                          },
                        },
                        required: ["structureType", "coreDrive", "contentOutline"],
                      },
                      referenceAssets: {
                        type: Type.ARRAY,
                        items: {
                          type: Type.OBJECT,
                          properties: {
                            id: {
                              type: Type.STRING,
                              description: "Unique ID like personaje_01 (identity), personaje_01_vestuario_01 (outfit), locacion_01, prop_01",
                            },
                            name: {
                              type: Type.STRING,
                              description: "Descriptive name like 'The Protagonist', 'Industrial Factory', 'Rusty Mirror'",
                            },
                            type: {
                              type: Type.STRING,
                              enum: ["personaje", "personajes-vestuario", "locacion", "prop"],
                            },
                            description: { type: Type.STRING },
                            generationPrompt: {
                              type: Type.STRING,
                              description:
                                "A detailed prompt to generate this specific asset. For personaje (identity), focus on face. For personajes-vestuario/prop, MUST include 'full body shot, centered, isolated on a pure white background, studio lighting, high resolution'.",
                            },
                          },
                          required: ["id", "name", "type", "description", "generationPrompt"],
                        },
                      },
                      scriptAndSound: {
                        type: Type.OBJECT,
                        properties: {
                          bgmBrief: { type: Type.STRING },
                        },
                        required: ["bgmBrief"],
                      },
                    },
                    required: ["projectOverview", "creativeConcept", "referenceAssets", "scriptAndSound"],
                  },
                  shotList: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        sceneNumber: { type: Type.NUMBER },
                        shotNumber: { type: Type.NUMBER },
                        timecode: { type: Type.STRING },
                        caption: { type: Type.STRING },
                        startFrame: { type: Type.STRING },
                        actionCamera: { type: Type.STRING },
                        endFrame: { type: Type.STRING },
                        rhythm: { type: Type.STRING },
                        overallStyle: { type: Type.STRING },
                        narrativeFunction: { type: Type.STRING },
                        lyrics: { type: Type.STRING },
                        duration: { type: Type.STRING },
                        transitionEntry: { type: Type.STRING },
                        transitionExit: { type: Type.STRING },
                        editingRhythm: { type: Type.STRING },
                        imagePrompt: { type: Type.STRING },
                        animationPrompt: { type: Type.STRING },
                        assetReferences: {
                          type: Type.ARRAY,
                          items: { type: Type.STRING },
                          description: "List of ReferenceAsset IDs (max 3) used in this shot",
                        },
                      },
                      required: [
                        "sceneNumber",
                        "shotNumber",
                        "timecode",
                        "caption",
                        "startFrame",
                        "actionCamera",
                        "imagePrompt",
                        "animationPrompt",
                        "assetReferences",
                      ],
                    },
                  },
                },
                required: ["creativeBrief", "shotList"],
              },
            },
          })
        );

        const text = response.text;
        if (!text) {
          throw new Error("No response from Gemini");
        }

        return res.json(JSON.parse(text));
      } catch (geminiErr: any) {
        if (getNvidiaApiKey()) {
          console.info("Falling back to NVIDIA NIM (Nemotron 3.5 Super VL 120B) for storyboard generation...");
          const storyboardJson = await generateJsonWithNvidiaNIM(
            systemInstruction,
            userPromptText,
            referenceImages
          );
          return res.json(storyboardJson);
        }
        throw geminiErr;
      }
    } catch (error: any) {
      const { statusCode, message } = formatErrorResponse(error);
      console.warn(`Storyboard generation error (${statusCode}): ${message}`);
      return res.status(statusCode).json({ error: message });
    }
  });

  // Generate character image (NVIDIA Cosmos 3 Nano primary, Gemini fallback)
  app.post("/api/gemini/generate-character-image", async (req, res) => {
    try {
      const { prompt, aspectRatio = "16:9", referenceImages } = req.body as {
        prompt: string;
        aspectRatio?: string;
        referenceImages?: ReferenceImage[];
      };

      const cinematicPrompt = `${prompt}. Cinematic photography, hyper-realistic, 8k, highly detailed, masterwork, cinematic lighting, no plastic textures, super real, 35mm film grain.`;

      // 1. Try NVIDIA Cosmos 3 Nano (nvidia/cosmos3-nano)
      if (process.env.NVIDIA_API_KEY) {
        const cosmosResult = await enqueueImageRequest(() =>
          generateImageWithCosmos3Nano(cinematicPrompt, aspectRatio)
        );
        if (cosmosResult) {
          return res.json(cosmosResult);
        }
      }

      // 2. Fallback to Gemini image generation if configured
      const ai = getAI();
      const parts: any[] = [];

      if (referenceImages && referenceImages.length > 0) {
        referenceImages.forEach((img) => {
          parts.push({
            inlineData: {
              data: img.data,
              mimeType: img.mimeType,
            },
          });
        });
        parts.push({
          text: `Based on these reference images, generate a master character reference: ${cinematicPrompt}`,
        });
      } else {
        parts.push({ text: cinematicPrompt });
      }

      const response = await enqueueImageRequest(() =>
        withRetry(() =>
          ai.models.generateContent({
            model: IMAGE_MODEL,
            contents: { parts },
            config: {
              imageConfig: {
                aspectRatio: aspectRatio as any,
              },
            },
          })
        )
      );

      for (const part of response.candidates?.[0]?.content?.parts || []) {
        if (part.inlineData?.data) {
          const mimeType = part.inlineData.mimeType || "image/png";
          return res.json({
            base64: part.inlineData.data,
            mimeType,
            dataUrl: `data:${mimeType};base64,${part.inlineData.data}`,
          });
        }
      }

      return res.json({ result: null });
    } catch (error: any) {
      const { statusCode, message } = formatErrorResponse(error);
      console.warn(`Character image generation error (${statusCode}): ${message}`);
      return res.status(statusCode).json({ error: message });
    }
  });

  // Generate scene image (NVIDIA Cosmos 3 Nano primary, Gemini fallback)
  app.post("/api/gemini/generate-scene-image", async (req, res) => {
    try {
      const { prompt, aspectRatio = "16:9", referenceImageBase64, mimeType } = req.body as {
        prompt: string;
        aspectRatio?: string;
        referenceImageBase64?: string;
        mimeType?: string;
      };

      const cinematicPrompt = `${prompt}. Cinematic photography, hyper-realistic, 8k, highly detailed, masterwork, cinematic lighting, no plastic textures, super real, 35mm film grain.`;

      // 1. Try NVIDIA Cosmos 3 Nano (nvidia/cosmos3-nano)
      if (process.env.NVIDIA_API_KEY) {
        const cosmosResult = await enqueueImageRequest(() =>
          generateImageWithCosmos3Nano(cinematicPrompt, aspectRatio)
        );
        if (cosmosResult) {
          return res.json({ dataUrl: cosmosResult.dataUrl, model: "nvidia/cosmos3-nano" });
        }
      }

      // 2. Fallback to Gemini image generation
      const ai = getAI();
      const parts: any[] = [];

      if (referenceImageBase64 && mimeType) {
        parts.push({
          inlineData: {
            data: referenceImageBase64,
            mimeType,
          },
        });
        parts.push({
          text: `Generate this exact scene featuring the character from the reference image: ${cinematicPrompt}`,
        });
      } else {
        parts.push({ text: cinematicPrompt });
      }

      const response = await enqueueImageRequest(() =>
        withRetry(() =>
          ai.models.generateContent({
            model: IMAGE_MODEL,
            contents: { parts },
            config: {
              imageConfig: {
                aspectRatio: aspectRatio as any,
              },
            },
          })
        )
      );

      for (const part of response.candidates?.[0]?.content?.parts || []) {
        if (part.inlineData?.data) {
          const mime = part.inlineData.mimeType || "image/png";
          return res.json({ dataUrl: `data:${mime};base64,${part.inlineData.data}` });
        }
      }

      return res.json({ dataUrl: null });
    } catch (error: any) {
      const { statusCode, message } = formatErrorResponse(error);
      console.warn(`Scene image generation error (${statusCode}): ${message}`);
      return res.status(statusCode).json({ error: message });
    }
  });

  // Generate scene video (NVIDIA Cosmos 3 Nano text2video/image2video primary, Gemini Omni Flash fallback)
  app.post("/api/gemini/generate-scene-video", async (req, res) => {
    try {
      const { prompt, aspectRatio = "16:9", imageUrl } = req.body as {
        prompt: string;
        aspectRatio?: string;
        imageUrl?: string;
      };

      const cinematicPrompt = `${prompt}. Cinematic camera movement, hyper-realistic 8k music video shot, smooth motion, 35mm film grain.`;
      const nvidiaKey = getNvidiaApiKey();

      // 1. Try NVIDIA Cosmos 3 Nano (image2video if reference data URL provided, otherwise text2video)
      if (nvidiaKey) {
        try {
          const resolution = mapAspectRatioToCosmosResolution(aspectRatio, "480");
          const hasImageRef = Boolean(imageUrl && (imageUrl.startsWith("data:image/") || imageUrl.startsWith("http")));
          const cosmosBody: Record<string, any> = hasImageRef
            ? {
                model_mode: "image2video",
                prompt: cinematicPrompt,
                input_reference: imageUrl,
                resolution,
                num_frames: 25,
                num_inference_steps: 35,
                fps: 24,
                seed: Math.floor(Math.random() * 1000000),
              }
            : {
                model_mode: "text2video",
                prompt: cinematicPrompt,
                resolution,
                num_frames: 25,
                num_inference_steps: 35,
                fps: 24,
                seed: Math.floor(Math.random() * 1000000),
              };

          const cosmosRes = await fetch(COSMOS3_NANO_URL, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${nvidiaKey}`,
              Accept: "application/json",
              "Content-Type": "application/json",
            },
            body: JSON.stringify(cosmosBody),
            signal: AbortSignal.timeout(45000),
          });

          if (cosmosRes.ok) {
            const cosmosData = (await cosmosRes.json()) as { b64_video?: string | null };
            if (cosmosData.b64_video) {
              return res.json({
                videoUrl: `data:video/mp4;base64,${cosmosData.b64_video}`,
                model: "nvidia/cosmos3-nano",
              });
            }
          }
        } catch (cosmosErr: any) {
          console.warn("Cosmos 3 Nano video notice:", cosmosErr?.message || cosmosErr);
        }
      }

      // 2. Try Gemini Omni Flash (gemini-omni-1.2-flash via Interactions API) if GEMINI_API_KEY is available
      if (process.env.GEMINI_API_KEY) {
        try {
          const ai = getAI();
          const inputParts: any[] = [];
          if (imageUrl && imageUrl.startsWith("data:image/")) {
            const [meta, b64] = imageUrl.split(",");
            const mime = meta.split(";")[0].replace("data:", "") || "image/jpeg";
            if (b64) {
              inputParts.push({
                type: "image",
                mime_type: mime,
                data: b64,
              });
            }
          }
          inputParts.push({
            type: "text",
            text: cinematicPrompt,
          });

          const validAspect = aspectRatio === "9:16" ? "9:16" : "16:9";
          const interaction = await (ai as any).interactions.create(
            {
              model: "gemini-omni-1.2-flash",
              input: inputParts.length === 1 ? cinematicPrompt : inputParts,
              background: false,
              store: false,
              stream: false,
              response_format: {
                type: "video",
                aspect_ratio: validAspect,
                duration: "8s",
                resolution: "720p",
              },
            },
            { timeout: 120000 }
          );

          const videoPart = interaction?.output_video;
          if (videoPart?.data) {
            const mime = videoPart.mime_type || "video/mp4";
            return res.json({
              videoUrl: `data:${mime};base64,${videoPart.data}`,
              model: "gemini-omni-1.2-flash",
            });
          }
        } catch (omniErr: any) {
          console.warn("Gemini Omni video notice:", omniErr?.message || omniErr);
        }
      }

      // 3. Return fallback flag so the client can synthesize a real 8s cinematic motion WebM clip from the scene image
      return res.json({ videoUrl: null, fallbackToClientMotion: true });
    } catch (error: any) {
      const { statusCode, message } = formatErrorResponse(error);
      console.warn(`Scene video generation error (${statusCode}): ${message}`);
      return res.status(statusCode).json({ error: message });
    }
  });

  // Generate asset image (NVIDIA Cosmos 3 Nano primary, Gemini fallback)
  app.post("/api/gemini/generate-asset-image", async (req, res) => {
    try {
      const { prompt, aspectRatio = "1:1" } = req.body as {
        prompt: string;
        aspectRatio?: string;
      };

      const cinematicPrompt = `${prompt}. Cinematic photography, hyper-realistic, 8k, highly detailed, masterwork, cinematic lighting, no plastic textures, super real, 35mm film grain.`;

      // 1. Try NVIDIA Cosmos 3 Nano (nvidia/cosmos3-nano)
      if (process.env.NVIDIA_API_KEY) {
        const cosmosResult = await enqueueImageRequest(() =>
          generateImageWithCosmos3Nano(cinematicPrompt, aspectRatio)
        );
        if (cosmosResult) {
          return res.json({ dataUrl: cosmosResult.dataUrl, model: "nvidia/cosmos3-nano" });
        }
      }

      // 2. Fallback to Gemini image generation
      const ai = getAI();

      const response = await enqueueImageRequest(() =>
        withRetry(() =>
          ai.models.generateContent({
            model: IMAGE_MODEL,
            contents: { parts: [{ text: cinematicPrompt }] },
            config: {
              imageConfig: {
                aspectRatio: aspectRatio as any,
              },
            },
          })
        )
      );

      for (const part of response.candidates?.[0]?.content?.parts || []) {
        if (part.inlineData?.data) {
          const mime = part.inlineData.mimeType || "image/png";
          return res.json({ dataUrl: `data:${mime};base64,${part.inlineData.data}` });
        }
      }

      return res.json({ dataUrl: null });
    } catch (error: any) {
      const { statusCode, message } = formatErrorResponse(error);
      console.warn(`Asset image generation error (${statusCode}): ${message}`);
      return res.status(statusCode).json({ error: message });
    }
  });

  // Generate custom directorial style
  app.post("/api/gemini/custom-style", async (req, res) => {
    try {
      const { userRequest } = req.body as { userRequest?: string };
      if (!userRequest) {
        return res.status(400).json({ error: "Missing userRequest." });
      }

      const systemInstruction = `You are a cinematic style expert. Based on the user's request, generate a new directorial style object.
    The output must be a JSON object with:
    - id: a unique string (kebab-case)
    - name: a professional name for the style
    - description: a short, evocative description (Spanish)
    - prompt: a detailed English prompt for image generation (Midjourney style)
    - params: technical parameters like --ar 2.39:1 --stylize 300`;

      try {
        const ai = getAI();
        const response = await withRetry(() =>
          ai.models.generateContent({
            model: TEXT_MODEL,
            contents: { parts: [{ text: userRequest }] },
            config: {
              systemInstruction,
              responseMimeType: "application/json",
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  id: { type: Type.STRING },
                  name: { type: Type.STRING },
                  description: { type: Type.STRING },
                  prompt: { type: Type.STRING },
                  params: { type: Type.STRING },
                },
                required: ["id", "name", "description", "prompt", "params"],
              },
            },
          })
        );

        const text = response.text;
        if (!text) {
          throw new Error("No response from Gemini");
        }

        return res.json(JSON.parse(text));
      } catch (geminiErr: any) {
        if (getNvidiaApiKey()) {
          console.info("Falling back to NVIDIA NIM for custom style generation...");
          const styleJson = await generateJsonWithNvidiaNIM(systemInstruction, userRequest);
          return res.json(styleJson);
        }
        throw geminiErr;
      }
    } catch (error: any) {
      const { statusCode, message } = formatErrorResponse(error);
      console.warn(`Custom style generation error (${statusCode}): ${message}`);
      return res.status(statusCode).json({ error: message });
    }
  });

  // Unmatched API routes should return JSON 404
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "API route not found" });
  });

  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(port, "0.0.0.0", () => {
    console.log(`Server listening on http://0.0.0.0:${port}`);
  });
}

startServer();
