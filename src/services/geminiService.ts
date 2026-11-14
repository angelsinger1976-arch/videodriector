export interface ReferenceImage {
  data: string;
  mimeType: string;
}

export interface DirectorStyle {
  id?: string;
  name: string;
  description: string;
  prompt: string;
  params: string;
}

async function parseErrorMessage(response: Response): Promise<string> {
  try {
    const data = await response.json();
    if (data?.error) {
      return typeof data.error === "string" ? data.error : JSON.stringify(data.error);
    }
  } catch {
    // Ignore JSON parse errors on non-JSON error responses
  }
  return `Request failed with status ${response.status}`;
}

export async function transcribeAudio(
  audioBase64: string,
  mimeType: string
): Promise<{ text: string | null; error?: string }> {
  try {
    const response = await fetch("/api/gemini/transcribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audioBase64, mimeType }),
    });

    if (!response.ok) {
      const message = await parseErrorMessage(response);
      console.warn("Transcription notice:", message);
      return { text: null, error: message };
    }

    const data = await response.json();
    return { text: data.text ?? null };
  } catch (error: any) {
    const message = error?.message || "Could not transcribe audio automatically.";
    console.warn("Transcription notice:", message);
    return { text: null, error: message };
  }
}

export async function generateStoryboard(
  songDescription: string,
  videoConcept: string,
  numCharacters: number,
  directorId: string,
  videoType: string,
  durationSeconds: number,
  referenceImages?: ReferenceImage[],
  customDirector?: DirectorStyle
) {
  const response = await fetch("/api/gemini/storyboard", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      songDescription,
      videoConcept,
      numCharacters,
      directorId,
      videoType,
      durationSeconds,
      referenceImages,
      customDirector,
    }),
  });

  if (!response.ok) {
    const message = await parseErrorMessage(response);
    throw new Error(message);
  }

  return await response.json();
}

export async function generateCharacterImage(
  prompt: string,
  aspectRatio: string = "16:9",
  referenceImages?: ReferenceImage[]
) {
  try {
    const response = await fetch("/api/gemini/generate-character-image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, aspectRatio, referenceImages }),
    });

    if (!response.ok) {
      const message = await parseErrorMessage(response);
      console.warn("Character image generation notice:", message);
      return null;
    }

    const data = await response.json();
    if (!data?.dataUrl) return null;
    return data as { base64: string; mimeType: string; dataUrl: string };
  } catch (error) {
    console.warn("Character image generation notice:", error);
    return null;
  }
}

export async function generateSceneImage(
  prompt: string,
  aspectRatio: string = "16:9",
  referenceImageBase64?: string,
  mimeType?: string
) {
  try {
    const response = await fetch("/api/gemini/generate-scene-image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, aspectRatio, referenceImageBase64, mimeType }),
    });

    if (!response.ok) {
      const message = await parseErrorMessage(response);
      console.warn("Scene image generation notice:", message);
      return null;
    }

    const data = await response.json();
    return (data.dataUrl as string | null) ?? null;
  } catch (error) {
    console.warn("Scene image generation notice:", error);
    return null;
  }
}

export async function generateAssetImage(prompt: string, aspectRatio: string = "1:1") {
  const response = await fetch("/api/gemini/generate-asset-image", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, aspectRatio }),
  });

  if (!response.ok) {
    const message = await parseErrorMessage(response);
    if (response.status === 429 || response.status === 403 || response.status === 400) {
      const err: any = new Error(message);
      err.status = response.status;
      throw err;
    }
    console.warn("Asset image generation notice:", message);
    return null;
  }

  const data = await response.json();
  return (data.dataUrl as string | null) ?? null;
}

export async function generateCustomStyle(userRequest: string) {
  const response = await fetch("/api/gemini/custom-style", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userRequest }),
  });

  if (!response.ok) {
    const message = await parseErrorMessage(response);
    throw new Error(message);
  }

  return await response.json();
}

export async function synthesizeMotionVideoFromImage(
  imageUrl: string,
  aspectRatio: string = "16:9",
  durationSec: number = 4,
  cameraHint: string = "",
  lyricsText: string = ""
): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const width = aspectRatio === "9:16" ? 720 : aspectRatio === "1:1" ? 720 : 1280;
        const height = aspectRatio === "9:16" ? 1280 : aspectRatio === "1:1" ? 720 : 720;
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          resolve(null);
          return;
        }

        const stream = canvas.captureStream(30);
        const mimeTypes = [
          "video/webm;codecs=vp9",
          "video/webm;codecs=vp8",
          "video/webm",
        ];
        const supportedMime = mimeTypes.find((m) => MediaRecorder.isTypeSupported(m)) || "";
        const recorder = supportedMime
          ? new MediaRecorder(stream, { mimeType: supportedMime, videoBitsPerSecond: 4000000 })
          : new MediaRecorder(stream);

        const chunks: BlobPart[] = [];
        recorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) chunks.push(e.data);
        };
        recorder.onstop = () => {
          const blob = new Blob(chunks, { type: supportedMime || "video/webm" });
          resolve(URL.createObjectURL(blob));
        };

        recorder.start();

        const hintLower = cameraHint.toLowerCase();
        const zoomOut = hintLower.includes("pull") || hintLower.includes("wide") || hintLower.includes("out");
        const panRight = hintLower.includes("right") || hintLower.includes("pan") || hintLower.includes("track");
        const totalMs = Math.min(Math.max(durationSec, 3), 6) * 1000;
        const startTime = performance.now();

        const renderFrame = (now: number) => {
          const elapsed = now - startTime;
          const progress = Math.min(elapsed / totalMs, 1);
          // Smooth cosine easing
          const ease = 0.5 - Math.cos(progress * Math.PI) / 2;

          const scaleStart = zoomOut ? 1.22 : 1.04;
          const scaleEnd = zoomOut ? 1.04 : 1.22;
          const scale = scaleStart + (scaleEnd - scaleStart) * ease;

          const panX = panRight ? (ease - 0.5) * width * 0.06 : (0.5 - ease) * width * 0.04;
          const panY = (0.5 - ease) * height * 0.03;

          ctx.fillStyle = "#050505";
          ctx.fillRect(0, 0, width, height);

          ctx.save();
          ctx.translate(width / 2 + panX, height / 2 + panY);
          ctx.scale(scale, scale);

          const imgRatio = img.width / Math.max(img.height, 1);
          const canvasRatio = width / height;
          let drawW = width;
          let drawH = height;
          if (imgRatio > canvasRatio) {
            drawH = height;
            drawW = height * imgRatio;
          } else {
            drawW = width;
            drawH = width / imgRatio;
          }
          ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);
          ctx.restore();

          // Cinematic vignette + subtle anamorphic light flare
          const grad = ctx.createRadialGradient(
            width / 2,
            height / 2,
            width * 0.25,
            width / 2,
            height / 2,
            width * 0.75
          );
          grad.addColorStop(0, "rgba(0,0,0,0)");
          grad.addColorStop(1, "rgba(0,0,0,0.45)");
          ctx.fillStyle = grad;
          ctx.fillRect(0, 0, width, height);

          if (lyricsText && lyricsText !== "Instrumental") {
            ctx.save();
            ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
            const boxH = 44;
            ctx.fillRect(0, height - boxH - 20, width, boxH);
            ctx.font = "600 18px Inter, system-ui, sans-serif";
            ctx.fillStyle = "#f3f4f6";
            ctx.textAlign = "center";
            ctx.fillText(lyricsText.slice(0, 90), width / 2, height - 34);
            ctx.restore();
          }

          if (progress < 1) {
            requestAnimationFrame(renderFrame);
          } else {
            recorder.stop();
          }
        };

        requestAnimationFrame(renderFrame);
      } catch (err) {
        console.warn("Motion video synthesis fallback failed:", err);
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = imageUrl;
  });
}

export async function generateSceneVideo(
  prompt: string,
  aspectRatio: string = "16:9",
  imageUrl?: string,
  actionCamera?: string,
  lyrics?: string
): Promise<string | null> {
  try {
    const response = await fetch("/api/gemini/generate-scene-video", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, aspectRatio, imageUrl }),
    });

    if (response.ok) {
      const data = await response.json();
      if (data?.videoUrl) {
        return data.videoUrl as string;
      }
    }
  } catch (error) {
    console.warn("Server video generation notice, using client motion engine:", error);
  }

  if (imageUrl) {
    return await synthesizeMotionVideoFromImage(
      imageUrl,
      aspectRatio,
      4,
      actionCamera || prompt,
      lyrics || ""
    );
  }

  return null;
}
