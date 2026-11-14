import React, { useState, useRef, useEffect } from 'react';
import { Play, Pause, Upload, Wand2, Download, Music, Video, Sparkles, Settings, Loader2, FileAudio, CheckCircle2, Film, User as UserIcon, Palette, Copy, Check, X, ArrowLeft, Clapperboard, Link2, Maximize2, Minimize2, SkipBack } from 'lucide-react';
import WaveSurfer from 'wavesurfer.js';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { DIRECTORS } from './data/compendium';
import { DESPERTAR_DIGITAL_DATA } from './data/despertarDigital';
import { generateStoryboard, generateCharacterImage, generateSceneImage, generateAssetImage, generateSceneVideo, transcribeAudio, generateCustomStyle } from './services/geminiService';
import { jsPDF } from 'jspdf';
import html2canvas from 'html2canvas';
import { auth, db, loginWithGoogle, logout, onAuthStateChanged, type User, collection, doc, setDoc, getDocs, query, where, orderBy, onSnapshot, Timestamp, deleteDoc, handleFirestoreError, OperationType } from './firebase';
import StyleSelector from './components/StyleSelector';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Mock Data
const MOCK_AUDIO_URL = 'https://actions.google.com/sounds/v1/music/cinematic_orchestra_music.ogg';

type ReferenceAsset = {
  id: string;
  name: string;
  type: 'personaje' | 'personajes-vestuario' | 'locacion' | 'prop';
  description: string;
  generationPrompt: string;
  imageUrl?: string;
  isGenerating?: boolean;
};

type Clip = {
  id: string;
  sceneNumber: number;
  shotNumber?: number;
  timecode: string;
  start: number;
  duration: number;
  caption: string;
  startFrame?: string;
  actionCamera?: string;
  endFrame?: string;
  rhythm?: string;
  overallStyle: string;
  narrativeFunction: string;
  lyrics: string;
  transitionEntry: string;
  transitionExit: string;
  editingRhythm: string;
  imagePrompt: string;
  animationPrompt: string;
  imageUrl: string;
  videoUrl?: string;
  isGeneratingImage?: boolean;
  isGeneratingVideo?: boolean;
  assetReferences: string[]; // IDs of ReferenceAssets used in this shot
};

type CreativeBrief = {
  projectOverview: {
    title: string;
    targetAudience: string;
    rhythmDriver: string;
    estimatedDuration: string;
    summary: string;
  };
  creativeConcept: {
    structureType: string;
    coreDrive: string;
    contentOutline: { block: string; timeframe: string; strategy: string }[];
  };
  referenceAssets: ReferenceAsset[];
  scriptAndSound: {
    bgmBrief: string;
  };
};

type GenerationStep = 'upload' | 'analyze' | 'character' | 'storyboard' | 'generate' | 'complete' | 'projects';

type Project = {
  id: string;
  userId: string;
  title: string;
  createdAt: any;
  songDescription: string;
  directorId: string;
  videoType: string;
  aspectRatio: string;
  creativeBrief: CreativeBrief;
  clips: Clip[];
};

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoadingProjects, setIsLoadingProjects] = useState(false);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  
  // Workflow State
  const [currentStep, setCurrentStep] = useState<GenerationStep>('upload');
  const [directors, setDirectors] = useState(DIRECTORS);
  const [selectedDirector, setSelectedDirector] = useState(DIRECTORS[0].id);
  const [isGeneratingStyle, setIsGeneratingStyle] = useState(false);
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [referenceImages, setReferenceImages] = useState<string[]>([]);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [generationProgress, setGenerationProgress] = useState(0);
  const [statusMessage, setStatusMessage] = useState('');
  
  // New AI Inputs
  const [songDescription, setSongDescription] = useState('');
  const [videoConcept, setVideoConcept] = useState('');
  const [numCharacters, setNumCharacters] = useState(1);
  const [videoType, setVideoType] = useState('narrative');
  const [aspectRatio, setAspectRatio] = useState('16:9');
  const [manualDuration, setManualDuration] = useState<string>('');

  const [clips, setClips] = useState<Clip[]>([]);
  const [creativeBrief, setCreativeBrief] = useState<CreativeBrief | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [assetWarning, setAssetWarning] = useState<string | null>(null);

  // Video & Timeline Studio State
  const [isGeneratingAllVideos, setIsGeneratingAllVideos] = useState(false);
  const [isStitchingVideo, setIsStitchingVideo] = useState(false);
  const [stitchProgress, setStitchProgress] = useState(0);
  const [stitchedVideoUrl, setStitchedVideoUrl] = useState<string | null>(null);
  const [showMasterMonitor, setShowMasterMonitor] = useState(true);
  const [pasteUrlClipId, setPasteUrlClipId] = useState<string | null>(null);
  const [pasteVideoUrlInput, setPasteVideoUrlInput] = useState('');
  const masterVideoRef = useRef<HTMLVideoElement | null>(null);

  const waveformRef = useRef<HTMLDivElement>(null);
  const wavesurferRef = useRef<WaveSurfer | null>(null);

  // Initialize WaveSurfer
  useEffect(() => {
    if (!waveformRef.current) return;

    let audioUrl = MOCK_AUDIO_URL;
    if (audioFile && audioFile.size > 0) {
      audioUrl = URL.createObjectURL(audioFile);
    }

    const wavesurfer = WaveSurfer.create({
      container: waveformRef.current,
      waveColor: '#4b5563',
      progressColor: '#6366f1',
      cursorColor: '#f3f4f6',
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      height: 60,
      url: audioUrl,
    });

    wavesurfer.on('ready', () => {
      const dur = wavesurfer.getDuration();
      setDuration(dur);
      if (audioFile && audioFile.size > 0) {
        setManualDuration(Math.round(dur).toString());
      }
    });

    wavesurfer.on('audioprocess', () => {
      setCurrentTime(wavesurfer.getCurrentTime());
    });

    wavesurfer.on('interaction', () => {
      setCurrentTime(wavesurfer.getCurrentTime());
    });

    wavesurfer.on('play', () => setIsPlaying(true));
    wavesurfer.on('pause', () => setIsPlaying(false));

    wavesurferRef.current = wavesurfer;

    return () => {
      wavesurfer.destroy();
      if (audioUrl !== MOCK_AUDIO_URL) {
        URL.revokeObjectURL(audioUrl);
      }
    };
  }, [currentStep, audioFile]);

  // Auth Listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setUser(user);
      if (user) {
        fetchProjects(user.uid);
      } else {
        setProjects([]);
      }
    });
    return () => unsubscribe();
  }, []);

  const fetchProjects = async (uid: string) => {
    setIsLoadingProjects(true);
    const q = query(
      collection(db, 'projects'),
      where('userId', '==', uid)
    );

    try {
      const querySnapshot = await getDocs(q);
      const loadedProjects: Project[] = [];
      querySnapshot.forEach((docSnap) => {
        loadedProjects.push({ id: docSnap.id, ...docSnap.data() } as Project);
      });
      loadedProjects.sort((a, b) => {
        const timeA = a.createdAt?.toMillis ? a.createdAt.toMillis() : 0;
        const timeB = b.createdAt?.toMillis ? b.createdAt.toMillis() : 0;
        return timeB - timeA;
      });
      setProjects(loadedProjects);
    } catch (error) {
      try {
        handleFirestoreError(error, OperationType.LIST, 'projects');
      } catch {
        // Logged via handleFirestoreError; keep UI state clean
      }
    } finally {
      setIsLoadingProjects(false);
    }
  };

  const saveProject = async () => {
    if (!user || !creativeBrief || clips.length === 0) return;

    setIsSaving(true);
    const safeSlug =
      (creativeBrief.projectOverview.title || 'project')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'project';
    const projectId = `${safeSlug}-${Date.now()}`;
    const safeTitle = (creativeBrief.projectOverview.title || 'Untitled Project').slice(0, 200);

    // Strip embedded base64 data URLs if payload approaches Firestore's 1MB document limit
    const rawCandidate = {
      userId: user.uid,
      title: safeTitle,
      createdAt: Timestamp.now(),
      songDescription: (songDescription || '').slice(0, 20000),
      directorId: (selectedDirector || '').slice(0, 128),
      videoType: (videoType || 'narrative').slice(0, 64),
      aspectRatio: (aspectRatio || '16:9').slice(0, 16),
      creativeBrief,
      clips: clips.slice(0, 100),
    };

    const serializedSize = JSON.stringify(rawCandidate).length;
    const sanitizedBrief: CreativeBrief =
      serializedSize > 750000
        ? {
            ...creativeBrief,
            referenceAssets: (creativeBrief.referenceAssets || []).map((a) => ({
              ...a,
              imageUrl: a.imageUrl?.startsWith('data:') ? '' : a.imageUrl,
            })),
          }
        : creativeBrief;

    const sanitizedClips: Clip[] = clips.slice(0, 100).map((c, idx) => {
      const cleanVideoUrl =
        c.videoUrl && (c.videoUrl.startsWith('blob:') || c.videoUrl.startsWith('data:'))
          ? undefined
          : c.videoUrl;
      return {
        ...c,
        videoUrl: cleanVideoUrl,
        imageUrl:
          serializedSize > 750000 && c.imageUrl?.startsWith('data:')
            ? `https://picsum.photos/seed/${safeSlug}-${idx}/1920/1080`
            : c.imageUrl,
      };
    });

    const projectData: Omit<Project, 'id'> = {
      ...rawCandidate,
      creativeBrief: sanitizedBrief,
      clips: sanitizedClips,
    };

    try {
      await setDoc(doc(db, 'projects', projectId), projectData);
      setStatusMessage('Project saved to database.');
      fetchProjects(user.uid);
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `projects/${projectId}`);
    } finally {
      setIsSaving(false);
    }
  };

  const deleteProject = async (projectId: string) => {
    if (!user) return;
    try {
      await deleteDoc(doc(db, 'projects', projectId));
      setProjects(prev => prev.filter(p => p.id !== projectId));
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `projects/${projectId}`);
    }
  };

  const loadProject = (project: Project) => {
    setCreativeBrief(project.creativeBrief);
    setClips(project.clips);
    setSongDescription(project.songDescription);
    setSelectedDirector(project.directorId);
    setVideoType(project.videoType);
    setAspectRatio(project.aspectRatio);
    setCurrentStep('complete');
  };
  
  const handleCreateCustomStyle = async (request: string) => {
    setIsGeneratingStyle(true);
    try {
      const newStyle = await generateCustomStyle(request);
      
      // Ensure ID is unique
      let finalId = newStyle.id;
      let counter = 1;
      while (directors.some(d => d.id === finalId)) {
        finalId = `${newStyle.id}_${counter}`;
        counter++;
      }

      const styleWithThumb = {
        ...newStyle,
        id: finalId,
        thumbnail: `https://picsum.photos/seed/${finalId}/800/450`
      };
      setDirectors(prev => [...prev, styleWithThumb]);
      setSelectedDirector(finalId);
      setStatusMessage(`New style created: ${newStyle.name}`);
    } catch (error) {
      console.error("Failed to create custom style:", error);
      setStatusMessage("Failed to create custom style. Please try again.");
    } finally {
      setIsGeneratingStyle(false);
    }
  };

  const togglePlay = () => {
    if (wavesurferRef.current) {
      wavesurferRef.current.playPause();
    }
  };

  const seekToTime = (targetSeconds: number) => {
    const clamped = Math.max(0, targetSeconds);
    setCurrentTime(clamped);
    if (wavesurferRef.current) {
      const wsDuration = wavesurferRef.current.getDuration();
      if (wsDuration > 0) {
        wavesurferRef.current.setTime(Math.min(clamped, wsDuration));
      }
    }
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      if (referenceImages.length >= 4) return;
      
      const file = e.target.files[0];
      const reader = new FileReader();
      reader.onload = () => {
        setReferenceImages(prev => [...prev, reader.result as string]);
      };
      reader.readAsDataURL(file);
    }
  };

  const removeReferenceImage = (index: number) => {
    setReferenceImages(prev => prev.filter((_, i) => i !== index));
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      setAudioFile(file);
      
      // Get audio duration automatically
      const audio = new Audio();
      const objectUrl = URL.createObjectURL(file);
      audio.src = objectUrl;
      audio.onloadedmetadata = () => {
        const dur = Math.round(audio.duration);
        setManualDuration(dur.toString());
        setDuration(audio.duration);
        URL.revokeObjectURL(objectUrl);
      };

      setCurrentStep('analyze');
      setIsTranscribing(true);
      setAssetWarning(null);
      
      try {
        const reader = new FileReader();
        reader.onload = async () => {
          const base64 = (reader.result as string).split(',')[1];
          const result = await transcribeAudio(base64, file.type || 'audio/mp3');
          if (result.text) {
            setSongDescription(result.text);
          } else if (result.error) {
            setAssetWarning(`Automatic audio transcription skipped: ${result.error} You can still paste or type your song lyrics and vibe below.`);
          }
          setIsTranscribing(false);
        };
        reader.readAsDataURL(file);
      } catch (error) {
        console.warn("Transcription notice:", error);
        setIsTranscribing(false);
      }
    }
  };

  const [copiedPrompt, setCopiedPrompt] = useState<string | null>(null);
  const [copiedAnimationPrompt, setCopiedAnimationPrompt] = useState<string | null>(null);

  const handleCopyPrompt = (prompt: string, type: 'image' | 'animation') => {
    navigator.clipboard.writeText(prompt);
    if (type === 'image') {
      setCopiedPrompt(prompt);
      setTimeout(() => setCopiedPrompt(null), 2000);
    } else {
      setCopiedAnimationPrompt(prompt);
      setTimeout(() => setCopiedAnimationPrompt(null), 2000);
    }
  };

  const handleDownloadImage = (imageUrl: string, index: number) => {
    const a = document.createElement('a');
    a.href = imageUrl;
    a.download = `scene-${index + 1}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handleRegenerateAssetImage = async (assetId: string) => {
    if (!creativeBrief) return;
    const targetAsset = creativeBrief.referenceAssets.find(a => a.id === assetId);
    if (!targetAsset) return;

    setCreativeBrief(prev =>
      prev
        ? {
            ...prev,
            referenceAssets: prev.referenceAssets.map(a =>
              a.id === assetId ? { ...a, isGenerating: true } : a
            ),
          }
        : null
    );

    const isFullBody = targetAsset.type === 'personajes-vestuario' || targetAsset.type === 'prop';
    const ratio = targetAsset.type === 'personaje' ? '1:1' : isFullBody ? '3:4' : '1:1';

    try {
      const imageUrl = await generateAssetImage(targetAsset.generationPrompt, ratio);
      setCreativeBrief(prev =>
        prev
          ? {
              ...prev,
              referenceAssets: prev.referenceAssets.map(a =>
                a.id === assetId ? { ...a, imageUrl: imageUrl || a.imageUrl, isGenerating: false } : a
              ),
            }
          : null
      );
    } catch (err: any) {
      setAssetWarning(err?.message || 'Could not generate image with NVIDIA Cosmos 3 Nano.');
      setCreativeBrief(prev =>
        prev
          ? {
              ...prev,
              referenceAssets: prev.referenceAssets.map(a =>
                a.id === assetId ? { ...a, isGenerating: false } : a
              ),
            }
          : null
      );
    }
  };

  const handleGenerateClipImage = async (clipId: string) => {
    const targetClip = clips.find(c => c.id === clipId);
    if (!targetClip) return;

    setClips(prev => prev.map(c => (c.id === clipId ? { ...c, isGeneratingImage: true } : c)));

    try {
      const imageUrl = await generateSceneImage(targetClip.imagePrompt, aspectRatio);
      setClips(prev =>
        prev.map(c =>
          c.id === clipId
            ? { ...c, imageUrl: imageUrl || c.imageUrl, isGeneratingImage: false }
            : c
        )
      );
    } catch (err: any) {
      setAssetWarning(err?.message || 'Could not generate scene image with NVIDIA Cosmos 3 Nano.');
      setClips(prev => prev.map(c => (c.id === clipId ? { ...c, isGeneratingImage: false } : c)));
    }
  };

  const handleGenerateClipVideo = async (clipId: string) => {
    const targetClip = clips.find(c => c.id === clipId);
    if (!targetClip) return;

    setClips(prev => prev.map(c => (c.id === clipId ? { ...c, isGeneratingVideo: true } : c)));

    try {
      const videoUrl = await generateSceneVideo(
        targetClip.animationPrompt || targetClip.imagePrompt,
        aspectRatio,
        targetClip.imageUrl,
        targetClip.actionCamera,
        targetClip.lyrics
      );
      if (videoUrl) {
        setClips(prev =>
          prev.map(c =>
            c.id === clipId ? { ...c, videoUrl, isGeneratingVideo: false } : c
          )
        );
      } else {
        setClips(prev => prev.map(c => (c.id === clipId ? { ...c, isGeneratingVideo: false } : c)));
      }
    } catch (err: any) {
      setAssetWarning(err?.message || 'No se pudo generar el video de la escena.');
      setClips(prev => prev.map(c => (c.id === clipId ? { ...c, isGeneratingVideo: false } : c)));
    }
  };

  const handleGenerateAllVideos = async () => {
    if (isGeneratingAllVideos || clips.length === 0) return;
    setIsGeneratingAllVideos(true);
    try {
      for (const clip of clips) {
        if (!clip.videoUrl) {
          await handleGenerateClipVideo(clip.id);
        }
      }
    } finally {
      setIsGeneratingAllVideos(false);
    }
  };

  const handleUploadClipVideo = (clipId: string, file: File) => {
    const objectUrl = URL.createObjectURL(file);
    setClips(prev =>
      prev.map(c => (c.id === clipId ? { ...c, videoUrl: objectUrl } : c))
    );
  };

  const handleConfirmPasteVideoUrl = (clipId: string) => {
    const trimmed = pasteVideoUrlInput.trim();
    if (!trimmed) return;
    setClips(prev =>
      prev.map(c => (c.id === clipId ? { ...c, videoUrl: trimmed } : c))
    );
    setPasteUrlClipId(null);
    setPasteVideoUrlInput('');
  };

  const handleStitchAndExportFullVideo = async () => {
    if (isStitchingVideo || clips.length === 0) return;
    setIsStitchingVideo(true);
    setStitchProgress(0);

    try {
      const canvas = document.createElement('canvas');
      canvas.width = 1280;
      canvas.height = 720;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('No 2D canvas context');

      const canvasStream = canvas.captureStream(30);

      // Prepare song audio track to mix into the stitched video
      let audioCtx: AudioContext | null = null;
      let audioEl: HTMLAudioElement | null = null;
      try {
        audioEl = new Audio();
        audioEl.crossOrigin = 'anonymous';
        audioEl.src =
          audioFile && audioFile.size > 0
            ? URL.createObjectURL(audioFile)
            : MOCK_AUDIO_URL;
        await new Promise<void>((res) => {
          if (!audioEl) return res();
          audioEl.oncanplay = () => res();
          audioEl.onerror = () => res();
          setTimeout(res, 1500);
        });
        audioCtx = new AudioContext();
        const source = audioCtx.createMediaElementSource(audioEl);
        const dest = audioCtx.createMediaStreamDestination();
        source.connect(dest);
        source.connect(audioCtx.destination);
        dest.stream.getAudioTracks().forEach((t) => canvasStream.addTrack(t));
      } catch {
        // Proceed with video-only stream if browser blocks cross-origin audio capture
      }

      const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
        ? 'video/webm;codecs=vp9'
        : MediaRecorder.isTypeSupported('video/webm')
        ? 'video/webm'
        : '';
      const recorder = mimeType
        ? new MediaRecorder(canvasStream, { mimeType, videoBitsPerSecond: 5_000_000 })
        : new MediaRecorder(canvasStream);

      const chunks: BlobPart[] = [];
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };

      const recordingDone = new Promise<string>((resolve) => {
        recorder.onstop = () => {
          const blob = new Blob(chunks, { type: mimeType || 'video/webm' });
          resolve(URL.createObjectURL(blob));
        };
      });

      recorder.start(100);
      if (audioEl) {
        audioEl.currentTime = 0;
        audioEl.play().catch(() => {});
      }

      // Render each clip sequentially on the timeline
      // To keep export fast while faithful to the timeline, cap each scene at 3s during stitch or full duration up to 4s
      for (let i = 0; i < clips.length; i++) {
        const clip = clips[i];
        setStitchProgress(Math.round((i / clips.length) * 100));

        const renderSeconds = Math.min(clip.duration || 4, 4);
        const totalFrames = Math.round(renderSeconds * 30);

        if (clip.videoUrl) {
          const vid = document.createElement('video');
          vid.crossOrigin = 'anonymous';
          vid.muted = true;
          vid.playsInline = true;
          vid.loop = true;
          vid.src = clip.videoUrl;
          await new Promise<void>((res) => {
            vid.onloadeddata = () => res();
            vid.onerror = () => res();
            setTimeout(res, 1500);
          });
          vid.play().catch(() => {});

          for (let f = 0; f < totalFrames; f++) {
            ctx.fillStyle = '#09090b';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            try {
              ctx.drawImage(vid, 0, 0, canvas.width, canvas.height);
            } catch {
              // ignore frame draw error
            }
            if (clip.lyrics && clip.lyrics !== 'Instrumental') {
              ctx.fillStyle = 'rgba(0,0,0,0.6)';
              ctx.fillRect(0, canvas.height - 68, canvas.width, 68);
              ctx.font = 'italic 600 22px Inter, system-ui, sans-serif';
              ctx.fillStyle = '#f4f4f5';
              ctx.textAlign = 'center';
              ctx.fillText(`"${clip.lyrics.slice(0, 90)}"`, canvas.width / 2, canvas.height - 26);
            }
            await new Promise((r) => setTimeout(r, 33));
          }
          vid.pause();
        } else {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          await new Promise<void>((res) => {
            img.onload = () => res();
            img.onerror = () => res();
            img.src = clip.imageUrl;
          });

          for (let f = 0; f < totalFrames; f++) {
            const p = f / totalFrames;
            const scale = 1.0 + p * 0.12;
            ctx.fillStyle = '#09090b';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            if (img.naturalWidth > 0) {
              ctx.save();
              ctx.translate(canvas.width / 2, canvas.height / 2);
              ctx.scale(scale, scale);
              const imgAspect = img.naturalWidth / img.naturalHeight;
              const canvasAspect = canvas.width / canvas.height;
              let dw = canvas.width;
              let dh = canvas.height;
              if (imgAspect > canvasAspect) {
                dh = canvas.height;
                dw = dh * imgAspect;
              } else {
                dw = canvas.width;
                dh = dw / imgAspect;
              }
              ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
              ctx.restore();
            }
            if (clip.lyrics && clip.lyrics !== 'Instrumental') {
              ctx.fillStyle = 'rgba(0,0,0,0.6)';
              ctx.fillRect(0, canvas.height - 68, canvas.width, 68);
              ctx.font = 'italic 600 22px Inter, system-ui, sans-serif';
              ctx.fillStyle = '#f4f4f5';
              ctx.textAlign = 'center';
              ctx.fillText(`"${clip.lyrics.slice(0, 90)}"`, canvas.width / 2, canvas.height - 26);
            }
            await new Promise((r) => setTimeout(r, 33));
          }
        }
      }

      setStitchProgress(100);
      if (audioEl) audioEl.pause();
      if (audioCtx) audioCtx.close().catch(() => {});
      recorder.stop();

      const finalUrl = await recordingDone;
      setStitchedVideoUrl(finalUrl);

      // Automatically trigger download of the stitched video
      const a = document.createElement('a');
      a.href = finalUrl;
      a.download = `${(creativeBrief?.projectOverview.title || 'music-video').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-final.webm`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (err: any) {
      setAssetWarning(err?.message || 'Error al unir el video final.');
    } finally {
      setIsStitchingVideo(false);
    }
  };

  const startAutomatedProduction = async () => {
    setError(null);
    setAssetWarning(null);
    setCurrentStep('character');
    setGenerationProgress(10);
    setStatusMessage('Analyzing audio BPM, lyrics, and emotional map...');
    
    try {
      // 1. Generate Storyboard via Gemini
      setGenerationProgress(20);
      setStatusMessage('AI Director is writing the master storyboard...');
      
      const refImages = referenceImages.map(img => ({
        data: img.split(',')[1],
        mimeType: img.split(';')[0].split(':')[1]
      }));

      const activeDirector = directors.find(d => d.id === selectedDirector);

      const response = await generateStoryboard(
        songDescription, 
        videoConcept,
        numCharacters,
        selectedDirector, 
        videoType, 
        manualDuration ? parseInt(manualDuration) : Math.max(duration, 32),
        refImages,
        activeDirector
      );
      
      setCreativeBrief(response.creativeBrief);
      
      setCurrentStep('storyboard');
      setGenerationProgress(40);
      setStatusMessage('Generating Reference Assets (Ingredients)...');
      
      // 2. Generate Reference Assets (Ingredients)
      const assets = response.creativeBrief.referenceAssets;
      
      // Separate identities from other assets to ensure we generate them first for reference
      const identities = assets.filter((a: any) => a.type === 'personaje');
      const others = assets.filter((a: any) => a.type !== 'personaje');
      const orderedAssets = [...identities, ...others];

      const allUpdatedAssets: any[] = [];
      let quotaHalted = false;

      for (let i = 0; i < orderedAssets.length; i++) {
        const asset = orderedAssets[i];
        if (quotaHalted) {
          allUpdatedAssets.push({ ...asset, imageUrl: null, isGenerating: false });
          continue;
        }

        const progress = 40 + Math.round(((i + 1) / Math.max(orderedAssets.length, 1)) * 55);
        setGenerationProgress(progress);
        setStatusMessage(`Generating Reference Asset (${i + 1}/${orderedAssets.length}): ${asset.name}...`);

        const isFullBody = asset.type === 'personajes-vestuario' || asset.type === 'prop';
        const ratio = asset.type === 'personaje' ? '1:1' : isFullBody ? '3:4' : '1:1';

        try {
          const imageUrl = await generateAssetImage(asset.generationPrompt, ratio);
          allUpdatedAssets.push({ ...asset, imageUrl, isGenerating: false });
        } catch (assetErr: any) {
          allUpdatedAssets.push({ ...asset, imageUrl: null, isGenerating: false });
          if (assetErr?.status === 429 || assetErr?.status === 403 || assetErr?.status === 400) {
            quotaHalted = true;
            setAssetWarning(
              assetErr?.message ||
                'Reference image generation was paused due to API rate limits or quota. Your full storyboard and prompts are ready below.'
            );
          }
        }
      }

      setCreativeBrief(prev => prev ? { ...prev, referenceAssets: allUpdatedAssets } : null);

      // 3. Create initial clips (No scene images generated)
      let currentStartTime = 0;
      const newClips: Clip[] = response.shotList.map((scene: any) => {
        const shotDuration = parseFloat(scene.duration) || 8;
        
        // Find the primary character look for this shot to use as a placeholder
        const primaryAssetId = scene.assetReferences?.[0];
        const primaryAsset = allUpdatedAssets.find(a => a.id === primaryAssetId);
        const placeholderUrl = primaryAsset?.imageUrl || 'https://picsum.photos/seed/placeholder/1920/1080';

        const clip: Clip = {
          id: Math.random().toString(36).substring(7),
          sceneNumber: scene.sceneNumber,
          shotNumber: scene.shotNumber,
          timecode: scene.timecode,
          start: currentStartTime,
          duration: shotDuration,
          caption: scene.caption,
          startFrame: scene.startFrame,
          actionCamera: scene.actionCamera,
          endFrame: scene.endFrame,
          rhythm: scene.rhythm,
          overallStyle: scene.overallStyle,
          narrativeFunction: scene.narrativeFunction,
          lyrics: scene.lyrics,
          transitionEntry: scene.transitionEntry,
          transitionExit: scene.transitionExit,
          editingRhythm: scene.editingRhythm,
          imagePrompt: scene.imagePrompt,
          animationPrompt: scene.animationPrompt,
          assetReferences: scene.assetReferences || [],
          imageUrl: placeholderUrl,
          isGeneratingImage: false
        };
        currentStartTime += shotDuration;
        return clip;
      });
      
      setClips(newClips);
      
      // 4. Final Assembly
      setStatusMessage('Finalizing technical storyboard...');
      setGenerationProgress(100);
      
      setTimeout(() => {
        setCurrentStep('complete');
      }, 1000);
      
    } catch (err: any) {
      console.warn("Production halted:", err?.message || err);
      const errorMessage = err?.message || "An unexpected error occurred during generation.";
      setError(errorMessage);
      setStatusMessage('Error: AI Director encountered an issue.');
      // Don't switch to complete if there's an error, stay in progress or show error UI
    }
  };

  const exportToPDF = async () => {
    const element = document.getElementById('storyboard-content');
    if (!element) return;

    setStatusMessage('Preparing PDF export...');
    
    try {
      const canvas = await html2canvas(element, {
        scale: 2,
        useCORS: true,
        backgroundColor: '#0a0a0a'
      });
      
      const imgData = canvas.toDataURL('image/png');
      const pdf = new jsPDF('p', 'mm', 'a4');
      const imgProps = pdf.getImageProperties(imgData);
      const pdfWidth = pdf.internal.pageSize.getWidth();
      const pdfHeight = (imgProps.height * pdfWidth) / imgProps.width;
      
      pdf.addImage(imgData, 'PNG', 0, 0, pdfWidth, pdfHeight);
      pdf.save(`${creativeBrief?.projectOverview.title || 'storyboard'}.pdf`);
      setStatusMessage('PDF Exported Successfully.');
    } catch (error) {
      console.error("PDF export failed:", error);
      setStatusMessage('PDF Export failed.');
    }
  };

  // Find active clip based on current time
  const activeClip = clips.find(c => currentTime >= c.start && currentTime < c.start + c.duration);

  return (
    <div className="h-dvh w-full flex flex-col bg-[#0a0a0a] text-gray-200 font-sans overflow-hidden">
      {/* Top Navigation */}
      <header className="min-h-14 border-b border-[#27272a] bg-[#141414] flex flex-wrap items-center justify-between gap-2 px-4 py-2 shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-8 h-8 rounded bg-indigo-600 flex items-center justify-center cursor-pointer shrink-0" onClick={() => setCurrentStep('upload')}>
            <Sparkles className="w-5 h-5 text-white" />
          </div>
          <h1 className="font-semibold text-xs sm:text-sm tracking-wide truncate">ULTIMATE MUSIC VIDEO DIRECTOR <span className="text-gray-500 font-normal hidden md:inline">/ by thefirm media studios</span></h1>
        </div>
        
        <div className="flex items-center gap-4">
          {user ? (
            <div className="flex items-center gap-3">
              <button 
                onClick={() => setCurrentStep('projects')}
                className="text-xs text-gray-400 hover:text-white transition-colors"
              >
                My Projects
              </button>
              
              {currentStep === 'complete' && (
                <button 
                  onClick={saveProject}
                  disabled={isSaving}
                  className="flex items-center gap-2 px-3 py-1.5 bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-400 text-xs font-medium rounded border border-emerald-600/30 transition-all disabled:opacity-50"
                >
                  {isSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />}
                  Save Project
                </button>
              )}

              <div className="h-4 w-px bg-gray-800 mx-1" />
              
              <div className="flex items-center gap-2">
                <img src={user.photoURL || ''} alt="" className="w-6 h-6 rounded-full border border-gray-700" />
                <button onClick={logout} className="text-xs text-gray-500 hover:text-red-400 transition-colors">Logout</button>
              </div>
            </div>
          ) : (
            <button 
              onClick={loginWithGoogle}
              className="flex items-center gap-2 px-4 py-1.5 bg-white text-black text-xs font-bold rounded hover:bg-gray-200 transition-colors"
            >
              Login with Google
            </button>
          )}

          {currentStep === 'complete' && (
            <div className="flex items-center gap-2">
              <button 
                onClick={exportToPDF}
                className="flex items-center gap-2 px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium rounded transition-colors"
              >
                <Download className="w-4 h-4" />
                Export PDF Storyboard
              </button>
            </div>
          )}
        </div>
      </header>

      {/* Main Content Area */}
      <div className="flex-1 min-h-0 flex overflow-hidden relative">
        
        {/* Projects View */}
        {currentStep === 'projects' && (
          <div className="absolute inset-0 z-50 bg-[#0a0a0a] flex flex-col p-4 sm:p-8 overflow-y-auto">
            <div className="max-w-5xl mx-auto w-full space-y-8">
              <div className="flex items-center justify-between border-b border-[#27272a] pb-6">
                <div className="flex items-center gap-4">
                  <button onClick={() => setCurrentStep('upload')} className="p-2 hover:bg-[#1f1f1f] rounded-lg transition-colors">
                    <X className="w-6 h-6 text-gray-400" />
                  </button>
                  <h2 className="text-3xl font-bold text-white">My Storyboards</h2>
                </div>
                <button 
                  onClick={() => setCurrentStep('upload')}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg transition-colors"
                >
                  New Project
                </button>
              </div>

              {isLoadingProjects ? (
                <div className="flex flex-col items-center justify-center py-20 space-y-4">
                  <Loader2 className="w-10 h-10 text-indigo-500 animate-spin" />
                  <p className="text-gray-400">Loading your projects...</p>
                </div>
              ) : projects.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-20 space-y-6 text-center">
                  <div className="w-20 h-20 bg-[#141414] rounded-full flex items-center justify-center border border-[#27272a]">
                    <Film className="w-10 h-10 text-gray-600" />
                  </div>
                  <div className="space-y-2">
                    <h3 className="text-xl font-medium text-white">No projects found</h3>
                    <p className="text-gray-500 max-w-xs">Start your first AI-driven storyboard to see it here.</p>
                  </div>
                  <button 
                    onClick={() => setCurrentStep('upload')}
                    className="px-6 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg transition-colors"
                  >
                    Create Storyboard
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {projects.map((project) => (
                    <div 
                      key={project.id}
                      className="group bg-[#141414] border border-[#27272a] rounded-xl overflow-hidden hover:border-indigo-500/50 transition-all duration-300 flex flex-col"
                    >
                      <div className="aspect-video bg-black relative overflow-hidden">
                        <img 
                          src={project.clips[0]?.imageUrl || 'https://picsum.photos/seed/placeholder/800/450'} 
                          alt="" 
                          className="w-full h-full object-cover opacity-60 group-hover:scale-105 transition-transform duration-500"
                          referrerPolicy="no-referrer"
                        />
                        <div className="absolute inset-0 bg-gradient-to-t from-[#141414] to-transparent" />
                        <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between">
                          <span className="text-[10px] font-bold text-white bg-black/50 backdrop-blur px-2 py-1 rounded border border-white/10 uppercase tracking-wider">
                            {project.videoType}
                          </span>
                          <span className="text-[10px] text-gray-400">
                            {project.clips.length} Shots
                          </span>
                        </div>
                      </div>
                      <div className="p-5 flex-1 flex flex-col justify-between space-y-4">
                        <div className="space-y-1">
                          <h4 className="text-white font-semibold line-clamp-1">{project.title}</h4>
                          <p className="text-[10px] text-gray-500">
                            {project.createdAt?.toDate ? project.createdAt.toDate().toLocaleDateString() : 'Recently'}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <button 
                            onClick={() => loadProject(project)}
                            className="flex-1 py-2 bg-[#1f1f1f] hover:bg-indigo-600 text-white text-xs font-medium rounded transition-colors"
                          >
                            Open Project
                          </button>
                          <button 
                            onClick={() => deleteProject(project.id)}
                            className="p-2 bg-[#1f1f1f] hover:bg-red-600/20 text-gray-500 hover:text-red-400 rounded transition-colors"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Setup & Generation Overlay */}
        {currentStep !== 'complete' && currentStep !== 'projects' && (
          <div className="absolute inset-0 z-50 bg-[#0a0a0a] overflow-y-auto">
            <div className="min-h-full flex items-center justify-center p-4 sm:p-8">
              <div className={cn(
                "relative w-full bg-[#141414] border border-[#27272a] rounded-xl p-5 sm:p-8 shadow-2xl transition-all duration-500",
                currentStep === 'analyze' ? "max-w-6xl" : "max-w-2xl"
              )}>
              
                <div className="text-center mb-8 sm:mb-10">
                  <h2 className="text-xl sm:text-2xl font-bold text-white mb-2">Ultimate Music Video Director</h2>
                  <p className="text-gray-400 text-xs sm:text-sm">By thefirm media studios and gemini ai. Generate a complete visual storyboard and reference images for your manual video production.</p>
                </div>

              {/* Step 1: Upload */}
              {currentStep === 'upload' && (
                <div className="space-y-6">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {/* Audio Upload */}
                    <div className="border-2 border-dashed border-[#27272a] hover:border-indigo-500 transition-colors rounded-xl p-8 flex flex-col items-center justify-center text-center cursor-pointer relative min-h-[200px]">
                      <input 
                        type="file" 
                        accept="audio/*" 
                        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                        onChange={handleFileUpload}
                      />
                      <div className="w-12 h-12 bg-[#1f1f1f] rounded-full flex items-center justify-center mb-3">
                        <FileAudio className="w-6 h-6 text-indigo-400" />
                      </div>
                      <h3 className="text-sm font-medium text-white mb-1">Audio Track</h3>
                      <p className="text-[10px] text-gray-500">MP3, WAV, or Suno link</p>
                      {audioFile && (
                        <div className="mt-2 px-2 py-1 bg-indigo-500/10 rounded text-[10px] text-indigo-400 font-mono truncate max-w-full">
                          {audioFile.name}
                        </div>
                      )}
                    </div>

                    {/* Image Upload */}
                    <div className="border-2 border-dashed border-[#27272a] hover:border-indigo-500 transition-colors rounded-xl p-6 flex flex-col items-center justify-center text-center relative min-h-[200px]">
                      {referenceImages.length < 4 ? (
                        <>
                          <input 
                            type="file" 
                            accept="image/*" 
                            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
                            onChange={handleImageUpload}
                          />
                          <div className="w-10 h-10 bg-[#1f1f1f] rounded-full flex items-center justify-center mb-2">
                            <Palette className="w-5 h-5 text-purple-400" />
                          </div>
                          <h3 className="text-xs font-medium text-white mb-1">Artist References</h3>
                          <p className="text-[9px] text-gray-500 mb-4">Up to 4 characters/faces (PNG, JPG)</p>
                        </>
                      ) : (
                        <div className="mb-4">
                          <h3 className="text-xs font-medium text-indigo-400 mb-1">Max References Reached</h3>
                          <p className="text-[9px] text-gray-500">Remove one to add another</p>
                        </div>
                      )}

                      {referenceImages.length > 0 && (
                        <div className="grid grid-cols-2 gap-2 w-full mt-auto">
                          {referenceImages.map((img, idx) => (
                            <div key={idx} className="relative aspect-square bg-black rounded overflow-hidden group">
                              <img src={img} className="w-full h-full object-cover" alt={`Ref ${idx + 1}`} />
                              <button 
                                onClick={(e) => {
                                  e.stopPropagation();
                                  removeReferenceImage(idx);
                                }}
                                className="absolute top-1 right-1 p-1 bg-black/60 hover:bg-red-500/80 text-white rounded-full opacity-0 group-hover:opacity-100 transition-opacity z-20"
                              >
                                <X className="w-3 h-3" />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                  
                  <div className="flex flex-col gap-4">
                    <button 
                      onClick={() => setCurrentStep('analyze')}
                      disabled={!audioFile}
                      className="w-full py-3 bg-indigo-600 hover:bg-indigo-500 disabled:bg-[#27272a] disabled:text-gray-500 text-white text-sm font-medium rounded-lg flex items-center justify-center gap-2 transition-colors shadow-lg shadow-indigo-500/20"
                    >
                      Continue to Creative Setup
                    </button>

                    <div className="text-center flex flex-col gap-2">
                      <button 
                        onClick={() => {
                          setAudioFile(new File([""], "demo_track.mp3"));
                          setCurrentStep('analyze');
                        }}
                        className="text-[10px] text-indigo-400 hover:text-indigo-300 underline"
                      >
                        Or use demo track
                      </button>
                      <button 
                        onClick={() => {
                          setCreativeBrief(DESPERTAR_DIGITAL_DATA.creativeBrief as any);
                          let currentStartTime = 0;
                          setClips(DESPERTAR_DIGITAL_DATA.shotList.map((s: any, i) => {
                            const shotDuration = parseFloat(s.duration) || 8;
                            const clip = {
                              ...s,
                              id: `clip-${i}`,
                              start: currentStartTime,
                              duration: shotDuration,
                              imageUrl: `https://picsum.photos/seed/despertar-${i}/1920/1080`,
                              lyrics: s.lyrics || '',
                              transitionEntry: s.transitionEntry || 'N/A',
                              transitionExit: s.transitionExit || 'N/A',
                              editingRhythm: s.editingRhythm || 'N/A',
                              rhythm: s.rhythm || 'N/A'
                            };
                            currentStartTime += shotDuration;
                            return clip;
                          }) as any);
                          setCurrentStep('complete');
                        }}
                        className="text-[10px] text-emerald-400 hover:text-emerald-300 underline"
                      >
                        Load "Despertar Digital" Master Demo
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Step 2: Analyze & Setup */}
              {currentStep === 'analyze' && (
                <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-3">
                      <button 
                        onClick={() => setCurrentStep('upload')}
                        className="p-2 hover:bg-[#1f1f1f] rounded-full text-gray-400 hover:text-white transition-colors"
                      >
                        <ArrowLeft className="w-5 h-5" />
                      </button>
                      <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">Creative Direction</h3>
                    </div>
                    {audioFile && (
                      <span className="text-xs text-indigo-400 bg-indigo-400/10 px-2 py-1 rounded">Audio: {audioFile.name}</span>
                    )}
                  </div>

                  {assetWarning && (
                    <div className="rounded-xl p-3.5 bg-amber-500/10 border border-amber-500/30 flex items-start justify-between gap-3">
                      <p className="text-xs text-amber-300 leading-relaxed">{assetWarning}</p>
                      <button
                        onClick={() => setAssetWarning(null)}
                        className="text-amber-300 hover:text-white shrink-0"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  )}
                  
                  <div className="space-y-4">
                    <div>
                      <label className="text-xs text-gray-400 mb-1.5 block">Video Concept / Theme (What is the video about?)</label>
                      <textarea 
                        value={videoConcept}
                        onChange={e => setVideoConcept(e.target.value)}
                        placeholder="Describe your vision for the video (e.g., 'The video takes place on a beach at sunset', 'A futuristic city with neon lights')..."
                        className="w-full h-24 bg-[#0a0a0a] border border-[#27272a] rounded p-3 text-sm text-gray-200 focus:outline-none focus:border-indigo-500 resize-none"
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="text-xs text-gray-400 mb-1.5 block">Number of Characters (Max 3)</label>
                        <select 
                          value={numCharacters}
                          onChange={e => setNumCharacters(parseInt(e.target.value))}
                          className="w-full bg-[#0a0a0a] border border-[#27272a] rounded p-2.5 text-sm text-gray-200 focus:outline-none focus:border-indigo-500"
                        >
                          <option value={1}>1 Character</option>
                          <option value={2}>2 Characters</option>
                          <option value={3}>3 Characters</option>
                        </select>
                      </div>
                      <div>
                        <label className="text-xs text-gray-400 mb-1.5 block">Song Duration (sec)</label>
                        <input 
                          type="number"
                          value={manualDuration}
                          onChange={e => setManualDuration(e.target.value)}
                          placeholder={duration ? Math.floor(duration).toString() : "e.g. 180"}
                          className="w-full bg-[#0a0a0a] border border-[#27272a] rounded p-2.5 text-sm text-gray-200 focus:outline-none focus:border-indigo-500"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="text-xs text-gray-400 mb-1.5 block flex items-center justify-between">
                        Song Lyrics / Meaning / Vibe
                        {isTranscribing && (
                          <span className="text-indigo-400 flex items-center gap-1 animate-pulse">
                            <Loader2 className="w-3 h-3 animate-spin" />
                            Extracting lyrics from audio...
                          </span>
                        )}
                      </label>
                      <textarea 
                        value={songDescription}
                        onChange={e => setSongDescription(e.target.value)}
                        placeholder={isTranscribing ? "Extracting lyrics..." : "Paste your song lyrics here, or describe the meaning and vibe of the song..."}
                        disabled={isTranscribing}
                        className="w-full h-32 bg-[#0a0a0a] border border-[#27272a] rounded p-3 text-sm text-gray-200 focus:outline-none focus:border-indigo-500 resize-none disabled:opacity-50"
                      />
                    </div>

                    <div>
                      <label className="text-xs text-gray-400 mb-1.5 block">Video Structure</label>
                      <select 
                        value={videoType}
                        onChange={e => setVideoType(e.target.value)}
                        className="w-full bg-[#0a0a0a] border border-[#27272a] rounded p-2.5 text-sm text-gray-200 focus:outline-none focus:border-indigo-500"
                      >
                        <option value="narrative">Narrative (Story-driven)</option>
                        <option value="performance">Performance (Artist focused)</option>
                        <option value="conceptual">Conceptual (Abstract/Surreal)</option>
                      </select>
                    </div>

                    <StyleSelector 
                      directors={directors}
                      selectedId={selectedDirector}
                      onSelect={setSelectedDirector}
                      onCustomRequest={handleCreateCustomStyle}
                      isGenerating={isGeneratingStyle}
                    />

                    <div>
                      <div className="flex items-center justify-between mb-1.5">
                        <label className="text-xs text-gray-400 block">Aspect Ratio</label>
                      </div>
                      <div className="grid grid-cols-5 gap-2">
                        {['16:9', '9:16', '1:1', '4:3', '3:4'].map((ratio) => (
                          <button
                            key={ratio}
                            onClick={() => setAspectRatio(ratio)}
                            className={cn(
                              "py-2 text-[10px] font-bold rounded border transition-all",
                              aspectRatio === ratio 
                                ? "bg-indigo-600 border-indigo-500 text-white" 
                                : "bg-[#0a0a0a] border-[#27272a] text-gray-400 hover:border-gray-600"
                            )}
                          >
                            {ratio}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  <button 
                    onClick={startAutomatedProduction}
                    disabled={!songDescription}
                    className="w-full py-3 bg-indigo-600 hover:bg-indigo-500 disabled:bg-[#27272a] disabled:text-gray-500 text-white text-sm font-medium rounded-lg flex items-center justify-center gap-2 transition-colors mt-6 shadow-lg shadow-indigo-500/20"
                  >
                    <Wand2 className="w-4 h-4" />
                    Generate Master Storyboard
                  </button>
                </div>
              )}

              {/* Step 3: Generation Progress */}
              {['character', 'storyboard', 'generate'].includes(currentStep) && !error && (
                <div className="space-y-8 py-8 animate-in fade-in duration-500">
                  <div className="flex flex-col items-center justify-center text-center space-y-6">
                    <button 
                      onClick={() => setCurrentStep('analyze')}
                      className="absolute top-8 left-8 flex items-center gap-2 text-xs text-gray-500 hover:text-white transition-colors"
                    >
                      <ArrowLeft className="w-4 h-4" />
                      Cancel & Go Back
                    </button>
                    
                    {/* Status Icon */}
                    <div className="relative">
                      <div className="w-20 h-20 bg-[#1f1f1f] rounded-full flex items-center justify-center border border-[#27272a]">
                        {currentStep === 'character' && <UserIcon className="w-8 h-8 text-indigo-400 animate-pulse" />}
                        {currentStep === 'storyboard' && <Film className="w-8 h-8 text-indigo-400 animate-pulse" />}
                        {currentStep === 'generate' && <Video className="w-8 h-8 text-indigo-400 animate-pulse" />}
                      </div>
                      <svg className="absolute inset-0 w-full h-full -rotate-90" viewBox="0 0 100 100">
                        <circle cx="50" cy="50" r="48" fill="none" stroke="#27272a" strokeWidth="4" />
                        <circle cx="50" cy="50" r="48" fill="none" stroke="#6366f1" strokeWidth="4" strokeDasharray="301.59" strokeDashoffset={301.59 - (301.59 * generationProgress) / 100} className="transition-all duration-500 ease-out" />
                      </svg>
                    </div>

                    {/* Status Text */}
                    <div className="space-y-2">
                      <h3 className="text-lg font-medium text-white">AI Director is working...</h3>
                      <p className="text-sm text-indigo-400 font-mono h-5">{statusMessage}</p>
                    </div>

                    {/* Progress Steps */}
                    <div className="w-full max-w-md space-y-3 mt-4">
                      <ProgressStep label="1. Audio & Lyric Analysis" active={true} completed={generationProgress > 20} />
                      <ProgressStep label="2. AI Storyboard Generation" active={currentStep === 'character'} completed={generationProgress > 40} />
                      <ProgressStep label="3. Technical Shot List Assembly" active={currentStep === 'storyboard' || currentStep === 'generate'} completed={generationProgress > 95} />
                      <ProgressStep label="4. Final Reference Assembly" active={generationProgress > 95} completed={generationProgress === 100} />
                    </div>

                  </div>
                </div>
              )}

              {/* Error State */}
              {error && (
                <div className="flex flex-col items-center justify-center py-12 text-center space-y-6 animate-in zoom-in duration-300">
                  <div className="w-20 h-20 bg-red-500/10 rounded-full flex items-center justify-center border border-red-500/20">
                    <X className="w-10 h-10 text-red-500" />
                  </div>
                  <div className="space-y-2 max-w-md">
                    <h3 className="text-xl font-bold text-white">Production Halted</h3>
                    <p className="text-sm text-gray-400 leading-relaxed">
                      {error}
                    </p>
                  </div>
                  <div className="flex gap-4">
                    <button 
                      onClick={() => { setError(null); setCurrentStep('analyze'); }}
                      className="px-6 py-2 bg-[#27272a] hover:bg-[#3f3f46] text-white text-sm font-medium rounded-lg transition-colors"
                    >
                      Go Back
                    </button>
                    <button 
                      onClick={startAutomatedProduction}
                      className="px-6 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg transition-colors"
                    >
                      Retry Generation
                    </button>
                  </div>
                </div>
              )}

              </div>
            </div>
          </div>
        )}

        {/* Storyboard View (Only visible when complete) */}
        {currentStep === 'complete' && !creativeBrief && !error && (
          <div className="flex-1 flex flex-col items-center justify-center p-20 text-center space-y-6" style={{ backgroundColor: '#0a0a0a' }}>
            <div className="w-20 h-20 bg-gray-800 rounded-full flex items-center justify-center border border-gray-700">
              <FileAudio className="w-10 h-10 text-gray-500" />
            </div>
            <div className="space-y-2">
              <h3 className="text-xl font-bold text-white">No Storyboard Data Found</h3>
              <p className="text-sm text-gray-400">The AI Director was unable to finalize the storyboard data.</p>
            </div>
            <button 
              onClick={() => setCurrentStep('analyze')}
              className="px-6 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg transition-colors"
            >
              Restart Process
            </button>
          </div>
        )}

        {currentStep === 'complete' && creativeBrief && (
          <main id="storyboard-content" className="flex-1 flex flex-col relative overflow-y-auto" style={{ backgroundColor: '#0a0a0a' }}>
            <div className="p-8 max-w-7xl mx-auto w-full space-y-12">
              
              {/* Creative Brief Section */}
              <section className="space-y-8">
                <div className="border-b pb-4 flex items-center justify-between" style={{ borderColor: '#27272a' }}>
                  <div className="flex items-center gap-4">
                    <button 
                      onClick={() => setCurrentStep('analyze')}
                      className="p-2 rounded-full transition-colors"
                      style={{ backgroundColor: 'transparent', color: '#9ca3af' }}
                      title="Back to Setup"
                    >
                      <ArrowLeft className="w-6 h-6" />
                    </button>
                    <h2 className="text-3xl font-bold text-white flex items-center gap-3">
                      <Sparkles className="w-8 h-8" style={{ color: '#6366f1' }} />
                      Creative Brief
                    </h2>
                  </div>
                </div>

                {assetWarning && (
                  <div className="rounded-xl p-4 flex items-start justify-between gap-4" style={{ backgroundColor: 'rgba(245, 158, 11, 0.1)', border: '1px solid rgba(245, 158, 11, 0.3)' }}>
                    <p className="text-xs leading-relaxed" style={{ color: '#fcd34d' }}>
                      {assetWarning}
                    </p>
                    <button
                      onClick={() => setAssetWarning(null)}
                      className="text-xs shrink-0"
                      style={{ color: '#fcd34d' }}
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                )}

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                  {/* Project Overview */}
                  <div className="rounded-xl p-6 space-y-4" style={{ backgroundColor: '#141414', border: '1px solid #27272a' }}>
                    <h3 className="text-lg font-semibold flex items-center gap-2" style={{ color: '#818cf8' }}>
                      <Settings className="w-5 h-5" />
                      Project Overview
                    </h3>
                    <div className="space-y-3 text-sm">
                      <p><span style={{ color: '#6b7280' }}>Title:</span> <span className="text-white">{creativeBrief.projectOverview.title}</span></p>
                      <p><span style={{ color: '#6b7280' }}>Target Audience:</span> <span className="text-white">{creativeBrief.projectOverview.targetAudience}</span></p>
                      <p><span style={{ color: '#6b7280' }}>Rhythm Driver:</span> <span className="text-white">{creativeBrief?.projectOverview?.rhythmDriver || "N/A"}</span></p>
                      <p><span style={{ color: '#6b7280' }}>Duration:</span> <span className="text-white">{creativeBrief?.projectOverview?.estimatedDuration || "N/A"}</span></p>
                      <p><span style={{ color: '#6b7280' }}>Summary:</span> <span className="leading-relaxed" style={{ color: '#d1d5db' }}>{creativeBrief?.projectOverview?.summary || "No summary available."}</span></p>
                    </div>
                  </div>

                  {/* Creative Concept */}
                  <div className="rounded-xl p-6 space-y-4" style={{ backgroundColor: '#141414', border: '1px solid #27272a' }}>
                    <h3 className="text-lg font-semibold flex items-center gap-2" style={{ color: '#c084fc' }}>
                      <Palette className="w-5 h-5" />
                      Creative Concept & Structure
                    </h3>
                    <div className="space-y-3 text-sm">
                      <p><span style={{ color: '#6b7280' }}>Structure Type:</span> <span className="text-white">{creativeBrief?.creativeConcept?.structureType || "N/A"}</span></p>
                      <p><span style={{ color: '#6b7280' }}>Core Drive:</span> <span className="text-white">{creativeBrief?.creativeConcept?.coreDrive || "N/A"}</span></p>
                      <div className="mt-4 space-y-3">
                        <p className="text-xs font-bold uppercase tracking-wider" style={{ color: '#6b7280' }}>Content Outline</p>
                        {creativeBrief?.creativeConcept?.contentOutline?.map((item, idx) => (
                          <div key={idx} className="p-3 rounded border" style={{ backgroundColor: 'rgba(0,0,0,0.3)', borderColor: 'rgba(255,255,255,0.05)' }}>
                            <p className="font-medium text-xs" style={{ color: '#a5b4fc' }}>{item.block} ({item.timeframe})</p>
                            <p className="text-xs mt-1" style={{ color: '#9ca3af' }}>{item.strategy}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-8">
                  {/* Reference Assets (Ingredients) */}
                  <div className="rounded-xl p-6 space-y-6" style={{ backgroundColor: '#141414', border: '1px solid #27272a' }}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="text-lg font-semibold flex items-center gap-2" style={{ color: '#34d399' }}>
                        <Sparkles className="w-5 h-5" />
                        Reference Assets (Ingredients)
                      </h3>
                      <span className="px-2.5 py-1 text-[10px] font-mono rounded border" style={{ backgroundColor: 'rgba(118, 185, 0, 0.12)', borderColor: 'rgba(118, 185, 0, 0.35)', color: '#a3e635' }}>
                        Engine: nvidia/cosmos3-nano
                      </span>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                      {creativeBrief?.referenceAssets?.map((asset, idx) => (
                        <div key={idx} className="rounded-lg border overflow-hidden flex flex-col" style={{ backgroundColor: 'rgba(0,0,0,0.3)', borderColor: 'rgba(255,255,255,0.05)' }}>
                          <div className="aspect-square bg-black relative">
                            {asset.imageUrl ? (
                              <img 
                                src={asset.imageUrl} 
                                alt={asset.name} 
                                className="absolute inset-0 w-full h-full object-cover"
                                referrerPolicy="no-referrer"
                              />
                            ) : (
                              <div className="absolute inset-0 flex items-center justify-center" style={{ color: '#4b5563' }}>
                                {asset.isGenerating ? (
                                  <Loader2 className="w-8 h-8 animate-spin" style={{ color: '#a3e635' }} />
                                ) : (
                                  <UserIcon className="w-8 h-8" />
                                )}
                              </div>
                            )}
                            <div className="absolute top-2 left-2">
                              <span className="px-2 py-0.5 text-[8px] font-bold rounded border text-white uppercase" style={{ backgroundColor: 'rgba(0,0,0,0.8)', borderColor: 'rgba(255,255,255,0.2)' }}>
                                {asset.id}
                              </span>
                            </div>
                          </div>
                          <div className="p-3 space-y-2 flex-1 flex flex-col justify-between">
                            <div className="space-y-1.5">
                              <p className="text-white text-xs font-bold">{asset.name}</p>
                              <p className="text-[10px] uppercase font-bold" style={{ color: '#6b7280' }}>{asset.type}</p>
                              <p className="text-[10px] leading-relaxed line-clamp-3" style={{ color: '#9ca3af' }}>{asset.description}</p>
                            </div>
                            <div className="pt-2 border-t flex items-center justify-between gap-2" style={{ borderColor: 'rgba(255,255,255,0.05)' }}>
                              <button 
                                onClick={() => handleCopyPrompt(asset.generationPrompt, 'image')}
                                className="text-[9px] flex items-center gap-1"
                                style={{ color: '#818cf8' }}
                              >
                                <Copy className="w-3 h-3" />
                                Copy Prompt
                              </button>
                              <button
                                onClick={() => handleRegenerateAssetImage(asset.id)}
                                disabled={asset.isGenerating}
                                className="text-[9px] flex items-center gap-1 px-2 py-1 rounded border disabled:opacity-50"
                                style={{ backgroundColor: 'rgba(118, 185, 0, 0.15)', borderColor: 'rgba(118, 185, 0, 0.35)', color: '#a3e635' }}
                              >
                                {asset.isGenerating ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wand2 className="w-3 h-3" />}
                                {asset.imageUrl ? 'Regenerate' : 'Generate'}
                              </button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
                  <div className="rounded-xl p-6 space-y-4" style={{ backgroundColor: '#141414', border: '1px solid #27272a' }}>
                    <h3 className="text-lg font-semibold flex items-center gap-2" style={{ color: '#fbbf24' }}>
                      <Music className="w-5 h-5" />
                      BGM Brief
                    </h3>
                    <p style={{ color: '#d1d5db', fontSize: '0.875rem', lineHeight: '1.625' }}>{creativeBrief.scriptAndSound.bgmBrief}</p>
                  </div>
              </section>

              {/* Shot List Section */}
              <section className="space-y-8">
                <div className="border-b pb-4 flex flex-wrap items-center justify-between gap-4" style={{ borderColor: '#27272a' }}>
                  <div className="flex items-center gap-3">
                    <Film className="w-8 h-8" style={{ color: '#6366f1' }} />
                    <div>
                      <h2 className="text-3xl font-bold text-white">Shot List & Generación de Video por Escena</h2>
                      <p className="text-xs text-gray-400 mt-1">
                        Las imágenes ya están montadas en el Timeline inferior. Genera o pega el video de cada escena para reemplazar la imagen en el Timeline.
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      onClick={handleGenerateAllVideos}
                      disabled={isGeneratingAllVideos}
                      className="flex items-center gap-2 px-4 py-2 text-xs font-bold uppercase tracking-wider rounded-lg border transition-all disabled:opacity-50"
                      style={{ backgroundColor: 'rgba(99, 102, 241, 0.2)', borderColor: 'rgba(99, 102, 241, 0.5)', color: '#a5b4fc' }}
                    >
                      {isGeneratingAllVideos ? <Loader2 className="w-4 h-4 animate-spin" /> : <Clapperboard className="w-4 h-4" />}
                      {isGeneratingAllVideos ? 'Generando Videos...' : 'Generar Video en Todas las Escenas'}
                    </button>

                    <button
                      onClick={handleStitchAndExportFullVideo}
                      disabled={isStitchingVideo}
                      className="flex items-center gap-2 px-4 py-2 text-xs font-bold uppercase tracking-wider rounded-lg border transition-all disabled:opacity-50"
                      style={{ backgroundColor: 'rgba(16, 185, 129, 0.2)', borderColor: 'rgba(16, 185, 129, 0.5)', color: '#6ee7b7' }}
                    >
                      {isStitchingVideo ? <Loader2 className="w-4 h-4 animate-spin" /> : <Video className="w-4 h-4" />}
                      {isStitchingVideo ? `Uniendo Video Final (${stitchProgress}%)...` : 'Pegar / Unir Video Final'}
                    </button>
                  </div>
                </div>
                
                <div className="grid grid-cols-1 gap-12 pb-12">
                  {clips.map((clip, index) => {
                    const isCurrentSceneInSong = activeClip?.id === clip.id;
                    return (
                    <div
                      key={clip.id}
                      id={`scene-card-${clip.id}`}
                      className="rounded-xl overflow-hidden flex flex-col lg:flex-row shadow-2xl transition-all"
                      style={{
                        backgroundColor: '#141414',
                        border: isCurrentSceneInSong ? '2px solid #6366f1' : '1px solid #27272a',
                      }}
                    >
                      {/* Image / Video Preview Side */}
                      <div className="w-full lg:w-1/3 relative bg-black aspect-video lg:aspect-auto flex-shrink-0 min-h-[300px]">
                        {clip.videoUrl ? (
                          <video
                            src={clip.videoUrl}
                            poster={clip.imageUrl}
                            controls
                            loop
                            muted
                            playsInline
                            className="absolute inset-0 w-full h-full object-cover"
                          />
                        ) : (
                          <>
                            <img 
                              src={clip.imageUrl} 
                              alt={clip.caption}
                              className="absolute inset-0 w-full h-full object-cover opacity-75"
                              referrerPolicy="no-referrer"
                            />
                            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                              <span className="px-4 py-2 text-[10px] font-bold rounded-lg uppercase tracking-widest" style={{ backgroundColor: 'rgba(0,0,0,0.65)', color: '#a5b4fc', border: '1px solid rgba(99, 102, 241, 0.35)' }}>
                                {clip.isGeneratingVideo ? 'Generando Video...' : 'Imagen Montada en Timeline'}
                              </span>
                            </div>
                          </>
                        )}

                        <div className="absolute top-4 left-4 flex flex-col gap-2 pointer-events-none">
                          <div className="flex flex-wrap gap-2">
                            <span className="px-3 py-1 text-[10px] font-bold rounded-full text-white border" style={{ backgroundColor: 'rgba(0,0,0,0.8)', borderColor: 'rgba(255,255,255,0.2)' }}>
                              SCENE #{clip.sceneNumber}
                            </span>
                            <span className="px-3 py-1 text-[10px] font-bold rounded-full text-white border" style={{ backgroundColor: 'rgba(79, 70, 229, 0.8)', borderColor: 'rgba(129, 140, 248, 0.3)' }}>
                              SHOT #{clip.shotNumber}
                            </span>
                            <span
                              className="px-3 py-1 text-[10px] font-bold rounded-full border uppercase"
                              style={
                                clip.videoUrl
                                  ? { backgroundColor: 'rgba(16, 185, 129, 0.85)', borderColor: '#34d399', color: '#ffffff' }
                                  : { backgroundColor: 'rgba(39, 39, 42, 0.85)', borderColor: '#52525b', color: '#e4e4e7' }
                              }
                            >
                              {clip.videoUrl ? 'VIDEO MONTADO' : 'IMAGEN BASE'}
                            </span>
                          </div>
                          <span className="px-3 py-1 text-[10px] font-bold rounded-full border w-fit" style={{ backgroundColor: 'rgba(0,0,0,0.8)', color: '#d1d5db', borderColor: 'rgba(255,255,255,0.1)' }}>
                            {clip.timecode} ({clip.duration}s)
                          </span>
                        </div>
                      </div>
                      
                      {/* Details Side */}
                      <div className="p-8 flex-1 flex flex-col gap-6">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                          <div className="space-y-4">
                            <div>
                              <h4 className="text-[10px] font-bold uppercase tracking-widest mb-1" style={{ color: '#818cf8' }}>Caption</h4>
                              <p className="text-white text-sm leading-relaxed">{clip.caption}</p>
                            </div>
                            {clip.startFrame && (
                              <div>
                                <h4 className="text-[10px] font-bold uppercase tracking-widest mb-1" style={{ color: '#34d399' }}>Start Frame</h4>
                                <p className="text-xs" style={{ color: '#d1d5db' }}>{clip.startFrame}</p>
                              </div>
                            )}
                            {clip.actionCamera && (
                              <div>
                                <h4 className="text-[10px] font-bold uppercase tracking-widest mb-1" style={{ color: '#fbbf24' }}>Action & Camera</h4>
                                <p className="text-xs" style={{ color: '#d1d5db' }}>{clip.actionCamera}</p>
                              </div>
                            )}
                            {clip.endFrame && (
                              <div>
                                <h4 className="text-[10px] font-bold uppercase tracking-widest mb-1" style={{ color: '#60a5fa' }}>End Frame</h4>
                                <p className="text-xs" style={{ color: '#d1d5db' }}>{clip.endFrame}</p>
                              </div>
                            )}
                            <div>
                              <h4 className="text-[10px] font-bold uppercase tracking-widest mb-1" style={{ color: '#6b7280' }}>Overall Style</h4>
                              <p className="text-xs" style={{ color: '#d1d5db' }}>{clip.overallStyle}</p>
                            </div>
                            <div>
                              <h4 className="text-[10px] font-bold uppercase tracking-widest mb-1" style={{ color: '#6b7280' }}>Narrative Function</h4>
                              <p className="text-xs" style={{ color: '#d1d5db' }}>{clip.narrativeFunction}</p>
                            </div>
                            {clip.assetReferences && clip.assetReferences.length > 0 && (
                              <div>
                                <h4 className="text-[10px] font-bold uppercase tracking-widest mb-2" style={{ color: '#818cf8' }}>Asset References</h4>
                                <div className="flex flex-wrap gap-2">
                                  {clip.assetReferences.map(assetId => (
                                    <span key={assetId} className="px-2 py-1 text-[9px] font-bold rounded border uppercase" style={{ backgroundColor: 'rgba(49, 46, 129, 0.3)', borderColor: 'rgba(99, 102, 241, 0.2)', color: '#a5b4fc' }}>
                                      {assetId}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                          
                          <div className="space-y-4">
                            <div>
                              <h4 className="text-[10px] font-bold uppercase tracking-widest mb-1" style={{ color: '#c084fc' }}>Lyrics Allocation (Parte de la Canción)</h4>
                              <p className="text-xs italic" style={{ color: 'rgba(233, 213, 255, 0.85)' }}>"{clip.lyrics || 'Instrumental'}"</p>
                            </div>
                            <div className="grid grid-cols-2 gap-4">
                              <div>
                                <h4 className="text-[10px] font-bold uppercase tracking-widest mb-1" style={{ color: '#6b7280' }}>Exact Duration</h4>
                                <p className="text-xs font-mono" style={{ color: '#d1d5db' }}>{clip.duration}s ({formatTime(clip.start)} - {formatTime(clip.start + clip.duration)})</p>
                              </div>
                              <div>
                                <h4 className="text-[10px] font-bold uppercase tracking-widest mb-1" style={{ color: '#6b7280' }}>Editing Rhythm</h4>
                                <p className="text-xs" style={{ color: '#d1d5db' }}>{clip.editingRhythm}</p>
                              </div>
                            </div>
                            <div className="grid grid-cols-2 gap-4">
                              <div>
                                <h4 className="text-[10px] font-bold uppercase tracking-widest mb-1" style={{ color: '#6b7280' }}>Transition Entry</h4>
                                <p className="text-xs" style={{ color: '#d1d5db' }}>{clip.transitionEntry}</p>
                              </div>
                              <div>
                                <h4 className="text-[10px] font-bold uppercase tracking-widest mb-1" style={{ color: '#6b7280' }}>Transition Exit</h4>
                                <p className="text-xs" style={{ color: '#d1d5db' }}>{clip.transitionExit}</p>
                              </div>
                            </div>
                          </div>
                        </div>

                        {/* Prompts Section */}
                        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 pt-6 border-t" style={{ borderColor: 'rgba(255,255,255,0.05)' }}>
                          <div className="space-y-2">
                            <div className="flex items-center justify-between">
                              <h4 className="text-[10px] font-bold uppercase tracking-widest" style={{ color: '#34d399' }}>Image Generation Prompt</h4>
                              <button 
                                onClick={() => handleCopyPrompt(clip.imagePrompt, 'image')}
                                className="p-1.5 rounded transition-colors"
                              >
                                {copiedPrompt === clip.imagePrompt ? <Check className="w-3.5 h-3.5" style={{ color: '#4ade80' }} /> : <Copy className="w-3.5 h-3.5" style={{ color: '#6b7280' }} />}
                              </button>
                            </div>
                            <div className="p-3 rounded border flex-1" style={{ backgroundColor: 'rgba(0,0,0,0.5)', borderColor: 'rgba(255,255,255,0.05)' }}>
                              <p className="text-[11px] font-mono leading-relaxed" style={{ color: '#9ca3af' }}>{clip.imagePrompt}</p>
                            </div>
                          </div>

                          <div className="space-y-2">
                            <div className="flex items-center justify-between">
                              <h4 className="text-[10px] font-bold uppercase tracking-widest" style={{ color: '#fbbf24' }}>Animation Prompt (Flow/Luma/Cosmos)</h4>
                              <button 
                                onClick={() => handleCopyPrompt(clip.animationPrompt, 'animation')}
                                className="p-1.5 rounded transition-colors"
                              >
                                {copiedAnimationPrompt === clip.animationPrompt ? <Check className="w-3.5 h-3.5" style={{ color: '#4ade80' }} /> : <Copy className="w-3.5 h-3.5" style={{ color: '#6b7280' }} />}
                              </button>
                            </div>
                            <div className="p-3 rounded border flex-1" style={{ backgroundColor: 'rgba(0,0,0,0.5)', borderColor: 'rgba(255,255,255,0.05)' }}>
                              <p className="text-[11px] font-mono leading-relaxed" style={{ color: 'rgba(253, 230, 138, 0.6)' }}>{clip.animationPrompt}</p>
                            </div>
                          </div>
                        </div>
                        
                        {/* Action Buttons: Generate Image, Generate Video, Upload/Paste Video */}
                        <div className="flex flex-wrap items-center justify-between gap-3 pt-4 border-t" style={{ borderColor: 'rgba(255,255,255,0.05)' }}>
                          <button
                            onClick={() => seekToTime(clip.start)}
                            className="flex items-center gap-1.5 px-3 py-2 text-[10px] font-bold uppercase tracking-wider rounded border transition-colors"
                            style={{ backgroundColor: 'rgba(99, 102, 241, 0.1)', borderColor: 'rgba(99, 102, 241, 0.3)', color: '#a5b4fc' }}
                          >
                            <Play className="w-3 h-3" />
                            Ir a {formatTime(clip.start)} en Canción
                          </button>

                          <div className="flex flex-wrap items-center gap-2.5">
                            <button
                              onClick={() => handleGenerateClipImage(clip.id)}
                              disabled={clip.isGeneratingImage}
                              className="flex items-center gap-2 px-3.5 py-2 text-[10px] font-bold uppercase tracking-widest rounded border transition-colors disabled:opacity-50"
                              style={{ backgroundColor: 'rgba(118, 185, 0, 0.15)', borderColor: 'rgba(118, 185, 0, 0.4)', color: '#a3e635' }}
                            >
                              {clip.isGeneratingImage ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wand2 className="w-3.5 h-3.5" />}
                              {clip.isGeneratingImage ? 'Generando Imagen...' : 'Generar Imagen (Cosmos 3)'}
                            </button>

                            <button
                              onClick={() => handleGenerateClipVideo(clip.id)}
                              disabled={clip.isGeneratingVideo}
                              className="flex items-center gap-2 px-3.5 py-2 text-[10px] font-bold uppercase tracking-widest rounded border transition-colors disabled:opacity-50"
                              style={{ backgroundColor: 'rgba(16, 185, 129, 0.18)', borderColor: 'rgba(16, 185, 129, 0.5)', color: '#34d399' }}
                            >
                              {clip.isGeneratingVideo ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Video className="w-3.5 h-3.5" />}
                              {clip.isGeneratingVideo ? 'Generando Video...' : clip.videoUrl ? 'Regenerar Video' : 'Generar Video (Escena)'}
                            </button>

                            <label
                              className="flex items-center gap-2 px-3.5 py-2 text-[10px] font-bold uppercase tracking-widest rounded border cursor-pointer transition-colors"
                              style={{ backgroundColor: 'rgba(59, 130, 246, 0.15)', borderColor: 'rgba(59, 130, 246, 0.4)', color: '#60a5fa' }}
                            >
                              <Upload className="w-3.5 h-3.5" />
                              Subir Video
                              <input
                                type="file"
                                accept="video/*"
                                className="hidden"
                                onChange={(e) => {
                                  if (e.target.files?.[0]) {
                                    handleUploadClipVideo(clip.id, e.target.files[0]);
                                  }
                                }}
                              />
                            </label>

                            <button
                              onClick={() => {
                                setPasteUrlClipId(pasteUrlClipId === clip.id ? null : clip.id);
                                setPasteVideoUrlInput(clip.videoUrl || '');
                              }}
                              className="flex items-center gap-1.5 px-3 py-2 text-[10px] font-bold uppercase tracking-widest rounded border transition-colors"
                              style={{ backgroundColor: 'rgba(168, 85, 247, 0.15)', borderColor: 'rgba(168, 85, 247, 0.4)', color: '#c084fc' }}
                            >
                              <Link2 className="w-3.5 h-3.5" />
                              Pegar URL Video
                            </button>

                            <button 
                              onClick={() => handleDownloadImage(clip.imageUrl, index)}
                              className="flex items-center gap-1.5 px-3 py-2 bg-[#27272a] hover:bg-[#3f3f46] text-white text-[10px] font-bold uppercase tracking-widest rounded transition-colors"
                            >
                              <Download className="w-3.5 h-3.5" />
                              Img
                            </button>
                          </div>
                        </div>

                        {pasteUrlClipId === clip.id && (
                          <div className="flex items-center gap-2 p-3 rounded-lg border" style={{ backgroundColor: '#09090b', borderColor: '#3f3f46' }}>
                            <input
                              type="url"
                              value={pasteVideoUrlInput}
                              onChange={(e) => setPasteVideoUrlInput(e.target.value)}
                              placeholder="Pega aquí el enlace directo del video (.mp4 / .webm) para montar en esta escena..."
                              className="flex-1 bg-transparent text-xs text-white focus:outline-none font-mono"
                            />
                            <button
                              onClick={() => handleConfirmPasteVideoUrl(clip.id)}
                              className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-[10px] font-bold uppercase rounded"
                            >
                              Montar en Timeline
                            </button>
                            <button
                              onClick={() => setPasteUrlClipId(null)}
                              className="p-1.5 text-gray-400 hover:text-white"
                            >
                              <X className="w-4 h-4" />
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                  })}
                </div>
              </section>
            </div>
          </main>
        )}

        {/* Modal for Final Stitched Video Preview & Download */}
        {stitchedVideoUrl && (
          <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
            <div className="bg-[#141414] border border-[#27272a] rounded-2xl max-w-3xl w-full p-6 space-y-4 shadow-2xl">
              <div className="flex items-center justify-between border-b border-[#27272a] pb-3">
                <div className="flex items-center gap-2.5">
                  <Clapperboard className="w-5 h-5 text-emerald-400" />
                  <h3 className="text-base font-bold text-white">Video Musical Final Unido (Timeline Completo)</h3>
                </div>
                <button
                  onClick={() => setStitchedVideoUrl(null)}
                  className="p-1.5 text-gray-400 hover:text-white rounded-lg"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="aspect-video bg-black rounded-xl overflow-hidden border border-[#27272a]">
                <video
                  src={stitchedVideoUrl}
                  controls
                  autoPlay
                  className="w-full h-full object-contain"
                />
              </div>
              <div className="flex items-center justify-between pt-2">
                <p className="text-xs text-gray-400">
                  Todas las escenas montadas (imágenes animadas y videos) han sido unidas en orden con la canción.
                </p>
                <a
                  href={stitchedVideoUrl}
                  download={`${(creativeBrief?.projectOverview.title || 'video-musical').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-final.webm`}
                  className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold uppercase tracking-wider rounded-lg"
                >
                  <Download className="w-4 h-4" />
                  Descargar Video Final (.webm)
                </a>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Bottom Docked Multi-Track Timeline Studio (Mounted Scene Images/Videos + Song Waveform Underneath) */}
      {currentStep === 'complete' && creativeBrief && clips.length > 0 && (() => {
        const clipsTotalDuration = clips.reduce((acc, c) => acc + (c.duration || 8), 0);
        const totalTimelineDuration = Math.max(clipsTotalDuration, duration || 0, 1);
        const playheadPercent = Math.min(100, Math.max(0, (currentTime / totalTimelineDuration) * 100));
        const currentActiveClip = activeClip || clips[0];
        const readyVideosCount = clips.filter(c => Boolean(c.videoUrl)).length;

        return (
          <footer className="border-t border-[#27272a] bg-[#0e0e11] shrink-0 flex flex-col z-40 shadow-2xl">
            {/* Timeline Top Control Bar */}
            <div className="px-4 py-2 border-b border-[#27272a] bg-[#141418] flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <button
                  onClick={togglePlay}
                  className="w-9 h-9 rounded-full bg-indigo-600 hover:bg-indigo-500 text-white flex items-center justify-center shadow-lg transition-colors"
                  title={isPlaying ? 'Pausar Canción y Timeline' : 'Reproducir Canción y Timeline'}
                >
                  {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
                </button>
                <button
                  onClick={() => seekToTime(0)}
                  className="p-2 rounded-lg bg-[#1f1f24] hover:bg-[#2a2a32] text-gray-300 transition-colors"
                  title="Reiniciar al inicio (00:00)"
                >
                  <SkipBack className="w-3.5 h-3.5" />
                </button>

                <div className="font-mono text-xs bg-black/60 px-3 py-1.5 rounded border border-[#27272a] flex items-center gap-2">
                  <span className="text-indigo-400 font-bold">{formatTime(currentTime)}</span>
                  <span className="text-gray-600">/</span>
                  <span className="text-gray-400">{formatTime(totalTimelineDuration)}</span>
                </div>

                {currentActiveClip && (
                  <div className="hidden md:flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-500/10 border border-indigo-500/30 text-[11px]">
                    <span className="font-bold text-indigo-300">ESCENA #{currentActiveClip.sceneNumber}</span>
                    <span className="text-gray-500">•</span>
                    <span className="text-gray-300 italic truncate max-w-[260px]">
                      "{currentActiveClip.lyrics || currentActiveClip.caption}"
                    </span>
                  </div>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2.5">
                <span className="text-[11px] font-mono text-gray-400 bg-[#1c1c21] px-2.5 py-1 rounded border border-[#27272a]">
                  Escenas en Video: <strong className="text-emerald-400">{readyVideosCount}</strong> / {clips.length} (Imágenes montadas: {clips.length})
                </span>

                <button
                  onClick={handleGenerateAllVideos}
                  disabled={isGeneratingAllVideos}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 border border-indigo-500/40 rounded text-[11px] font-bold uppercase tracking-wider transition-all disabled:opacity-50"
                >
                  {isGeneratingAllVideos ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wand2 className="w-3.5 h-3.5" />}
                  {isGeneratingAllVideos ? 'Generando Videos...' : 'Convertir Imágenes a Video'}
                </button>

                <button
                  onClick={handleStitchAndExportFullVideo}
                  disabled={isStitchingVideo}
                  className="flex items-center gap-1.5 px-3.5 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded text-[11px] font-bold uppercase tracking-wider transition-all shadow-lg disabled:opacity-50"
                >
                  {isStitchingVideo ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Clapperboard className="w-3.5 h-3.5" />}
                  {isStitchingVideo ? `Pegando Video (${stitchProgress}%)...` : 'Pegar y Descargar Video Final'}
                </button>

                <button
                  onClick={() => setShowMasterMonitor(prev => !prev)}
                  className="p-1.5 rounded bg-[#1f1f24] hover:bg-[#27272a] text-gray-300 border border-[#27272a]"
                  title={showMasterMonitor ? 'Ocultar Monitor de Vista Previa' : 'Mostrar Monitor de Vista Previa'}
                >
                  {showMasterMonitor ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {/* Synchronized Master Monitor + Multi-Track Timeline Container */}
            <div className="flex flex-col lg:flex-row max-h-[300px] overflow-hidden">
              {/* Left: Live Synchronized Master Video Monitor */}
              {showMasterMonitor && currentActiveClip && (
                <div className="w-full lg:w-72 bg-black border-b lg:border-b-0 lg:border-r border-[#27272a] p-2.5 flex flex-col justify-between shrink-0">
                  <div className="relative aspect-video bg-[#09090b] rounded-lg overflow-hidden border border-[#27272a]">
                    {currentActiveClip.videoUrl ? (
                      <video
                        key={currentActiveClip.videoUrl}
                        ref={masterVideoRef}
                        src={currentActiveClip.videoUrl}
                        poster={currentActiveClip.imageUrl}
                        autoPlay
                        loop
                        muted
                        playsInline
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <img
                        src={currentActiveClip.imageUrl}
                        alt={currentActiveClip.caption}
                        className={cn(
                          "w-full h-full object-cover transition-transform duration-1000",
                          isPlaying ? "scale-110" : "scale-100"
                        )}
                        referrerPolicy="no-referrer"
                      />
                    )}
                    <div className="absolute top-1.5 left-1.5 flex items-center gap-1.5">
                      <span className="px-2 py-0.5 text-[9px] font-bold rounded bg-black/80 text-white border border-white/15">
                        ESCENA #{currentActiveClip.sceneNumber}
                      </span>
                      <span
                        className={cn(
                          "px-1.5 py-0.5 text-[8px] font-bold rounded uppercase",
                          currentActiveClip.videoUrl
                            ? "bg-emerald-600/90 text-white"
                            : "bg-indigo-600/90 text-white"
                        )}
                      >
                        {currentActiveClip.videoUrl ? 'VIDEO' : 'IMAGEN'}
                      </span>
                    </div>
                    {currentActiveClip.lyrics && (
                      <div className="absolute bottom-0 inset-x-0 bg-black/75 px-2 py-1 text-center">
                        <p className="text-[10px] text-amber-200 italic truncate">
                          "{currentActiveClip.lyrics}"
                        </p>
                      </div>
                    )}
                  </div>
                  <div className="mt-1.5 flex items-center justify-between text-[10px] text-gray-400 px-1">
                    <span className="truncate">Monitor Maestro (Sincronizado)</span>
                    <span className="font-mono text-indigo-400">{currentActiveClip.timecode}</span>
                  </div>
                </div>
              )}

              {/* Right: Horizontal Scrollable Multi-Track Timeline (Track 1: Mounted Scenes, Track 2: Song Audio) */}
              <div className="flex-1 overflow-x-auto overflow-y-hidden p-3 select-none">
                <div
                  className="relative min-w-[900px] space-y-2"
                  style={{ width: `${Math.max(900, clips.length * 145)}px` }}
                >
                  {/* Synchronized Vertical Playhead Scrubber spanning both Scene Track and Song Track */}
                  <div
                    className="absolute top-0 bottom-0 w-0.5 bg-rose-500 z-30 pointer-events-none"
                    style={{ left: `${playheadPercent}%` }}
                  >
                    <div className="w-3 h-3 -ml-[5px] -mt-1 rounded-full bg-rose-500 shadow-md shadow-rose-500/50" />
                  </div>

                  {/* Time Ruler */}
                  <div
                    onClick={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      const clickRatio = (e.clientX - rect.left) / rect.width;
                      seekToTime(clickRatio * totalTimelineDuration);
                    }}
                    className="h-5 bg-[#16161d] rounded border border-[#27272a] relative flex items-center cursor-pointer"
                    title="Haz clic para mover la aguja a cualquier parte de la canción"
                  >
                    {clips.map((clip) => {
                      const leftPct = (clip.start / totalTimelineDuration) * 100;
                      return (
                        <div
                          key={`ruler-${clip.id}`}
                          className="absolute top-0 bottom-0 border-l border-[#2e2e38] pl-1 flex items-center text-[9px] font-mono text-gray-400"
                          style={{ left: `${leftPct}%` }}
                        >
                          {formatTime(clip.start)}
                        </div>
                      );
                    })}
                  </div>

                  {/* TRACK 1: Mounted Images -> Videos Timeline */}
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-wider text-gray-400 px-1">
                      <span className="flex items-center gap-1.5 text-indigo-300">
                        <Film className="w-3 h-3" />
                        Pista 1: Timeline de Escenas (Imágenes Montadas → Videos)
                      </span>
                      <span className="text-[9px] text-gray-500">Haz clic en un bloque para saltar a esa parte de la canción o generar su video</span>
                    </div>

                    <div className="h-24 flex rounded-lg overflow-hidden border border-[#27272a] bg-[#09090b] relative">
                      {clips.map((clip) => {
                        const widthPct = ((clip.duration || 8) / totalTimelineDuration) * 100;
                        const isSelected = currentActiveClip?.id === clip.id;
                        return (
                          <div
                            key={`tl-${clip.id}`}
                            onClick={() => seekToTime(clip.start)}
                            style={{ width: `${widthPct}%` }}
                            className={cn(
                              "relative h-full border-r border-[#27272a] group cursor-pointer overflow-hidden flex flex-col justify-between p-1.5 transition-all",
                              isSelected ? "ring-2 ring-inset ring-indigo-500" : "hover:brightness-110"
                            )}
                          >
                            {/* Mounted Video or Mounted Image Background */}
                            {clip.videoUrl ? (
                              <video
                                src={clip.videoUrl}
                                poster={clip.imageUrl}
                                muted
                                loop
                                autoPlay
                                playsInline
                                className="absolute inset-0 w-full h-full object-cover opacity-80"
                              />
                            ) : (
                              <img
                                src={clip.imageUrl}
                                alt={clip.caption}
                                className="absolute inset-0 w-full h-full object-cover opacity-65 group-hover:scale-105 transition-transform"
                                referrerPolicy="no-referrer"
                              />
                            )}
                            <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/30 to-black/60" />

                            {/* Top Row: Scene Number & Status Badge */}
                            <div className="relative z-10 flex items-center justify-between gap-1">
                              <span className="text-[9px] font-bold text-white bg-black/75 px-1.5 py-0.5 rounded border border-white/10 truncate">
                                #{clip.sceneNumber} ({clip.duration}s)
                              </span>
                              <span
                                className={cn(
                                  "text-[8px] font-bold px-1.5 py-0.5 rounded uppercase shrink-0",
                                  clip.videoUrl
                                    ? "bg-emerald-500/90 text-black"
                                    : "bg-indigo-600/80 text-white"
                                )}
                              >
                                {clip.videoUrl ? 'VIDEO' : 'IMG'}
                              </span>
                            </div>

                            {/* Bottom Row: Quick Generate / Upload Video Actions on Timeline Block */}
                            <div className="relative z-10 flex items-center justify-between gap-1">
                              <span className="text-[9px] text-gray-200 truncate max-w-[65%] italic">
                                {clip.lyrics || clip.caption}
                              </span>

                              <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                                <button
                                  onClick={() => handleGenerateClipVideo(clip.id)}
                                  disabled={clip.isGeneratingVideo}
                                  title="Generar Video para esta escena"
                                  className="px-1.5 py-0.5 rounded bg-emerald-600/90 hover:bg-emerald-500 text-white text-[8px] font-bold uppercase flex items-center gap-0.5 disabled:opacity-50"
                                >
                                  {clip.isGeneratingVideo ? (
                                    <Loader2 className="w-2.5 h-2.5 animate-spin" />
                                  ) : (
                                    <Video className="w-2.5 h-2.5" />
                                  )}
                                  {clip.videoUrl ? 'Re' : 'Video'}
                                </button>

                                <label
                                  title="Subir archivo de video a esta escena"
                                  className="p-0.5 rounded bg-blue-600/80 hover:bg-blue-500 text-white cursor-pointer"
                                >
                                  <Upload className="w-2.5 h-2.5" />
                                  <input
                                    type="file"
                                    accept="video/*"
                                    className="hidden"
                                    onChange={(e) => {
                                      if (e.target.files?.[0]) {
                                        handleUploadClipVideo(clip.id, e.target.files[0]);
                                      }
                                    }}
                                  />
                                </label>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* TRACK 2: Song Audio Track Underneath ("abajo tiene que ir la canción") */}
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-wider text-amber-400 px-1">
                      <span className="flex items-center gap-1.5">
                        <Music className="w-3 h-3" />
                        Pista 2 (Abajo): Canción Sincronizada — {audioFile ? audioFile.name : 'Pista Musical Activa'}
                      </span>
                      <label className="text-[9px] text-indigo-400 hover:text-indigo-300 cursor-pointer flex items-center gap-1 normal-case">
                        <Upload className="w-2.5 h-2.5" />
                        Cambiar archivo de canción
                        <input
                          type="file"
                          accept="audio/*"
                          className="hidden"
                          onChange={(e) => {
                            if (e.target.files?.[0]) {
                              setAudioFile(e.target.files[0]);
                            }
                          }}
                        />
                      </label>
                    </div>

                    <div className="relative rounded-lg border border-[#27272a] bg-[#121217] overflow-hidden">
                      {/* Lyric alignment guides matching the scenes above */}
                      <div className="absolute inset-0 flex pointer-events-none z-10">
                        {clips.map((clip) => {
                          const widthPct = ((clip.duration || 8) / totalTimelineDuration) * 100;
                          return (
                            <div
                              key={`song-seg-${clip.id}`}
                              style={{ width: `${widthPct}%` }}
                              className="h-full border-r border-indigo-500/20 flex items-end p-1"
                            >
                              <span className="text-[9px] font-mono text-amber-300/80 bg-black/65 px-1.5 py-0.5 rounded truncate max-w-full">
                                ♪ Escena #{clip.sceneNumber}: {clip.lyrics || 'Instrumental'}
                              </span>
                            </div>
                          );
                        })}
                      </div>

                      {/* Interactive WaveSurfer Song Waveform */}
                      <div ref={waveformRef} className="w-full h-[60px]" />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </footer>
        );
      })()}
    </div>
  );
}

// Subcomponents

function ProgressStep({ label, active, completed }: { label: string, active: boolean, completed: boolean }) {
  return (
    <div className="flex items-center gap-3 text-left">
      <div className={cn(
        "w-5 h-5 rounded-full flex items-center justify-center shrink-0 border text-[10px]",
        completed ? "bg-emerald-500/20 border-emerald-500 text-emerald-400" :
        active ? "bg-indigo-500/20 border-indigo-500 text-indigo-400" :
        "bg-[#1f1f1f] border-[#27272a] text-gray-600"
      )}>
        {completed ? <CheckCircle2 className="w-3 h-3" /> : <span className="w-1.5 h-1.5 rounded-full bg-current" />}
      </div>
      <span className={cn(
        "text-xs font-medium",
        completed ? "text-gray-300" :
        active ? "text-white" :
        "text-gray-600"
      )}>
        {label}
      </span>
    </div>
  );
}

function formatTime(seconds: number) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 100);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
}

