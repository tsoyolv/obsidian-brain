"use client";

import { useEffect, useRef, useState } from "react";

interface Props {
  /** Called with the recorded audio blob and its mime type. */
  onRecorded: (blob: Blob, mimeType: string) => void;
  disabled?: boolean;
  className?: string;
}

/**
 * Microphone capture button using the MediaRecorder API.
 * - First click: starts recording.
 * - Second click: stops recording and emits the blob.
 *
 * Supported in modern browsers; for unsupported browsers the button is disabled.
 */
export function MicButton({ onRecorded, disabled, className }: Props) {
  const [recording, setRecording] = useState(false);
  const [supported, setSupported] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const ok =
      typeof window.MediaRecorder !== "undefined" &&
      !!navigator.mediaDevices?.getUserMedia;
    setSupported(ok);
  }, []);

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  async function start() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = pickMimeType();
      const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        const type = rec.mimeType || mimeType || "audio/webm";
        const blob = new Blob(chunksRef.current, { type });
        chunksRef.current = [];
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        onRecorded(blob, type);
      };
      recorderRef.current = rec;
      rec.start();
      setRecording(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Microphone unavailable");
      setRecording(false);
    }
  }

  function stop() {
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") rec.stop();
    setRecording(false);
  }

  if (!supported) {
    return (
      <button
        type="button"
        disabled
        title="MediaRecorder not supported"
        className={`btn ${className ?? ""}`}
      >
        Mic n/a
      </button>
    );
  }

  return (
    <div className={`flex items-center gap-2 ${className ?? ""}`}>
      <button
        type="button"
        onClick={recording ? stop : start}
        disabled={disabled}
        className={recording ? "btn-primary" : "btn"}
      >
        {recording ? (
          <>
            <span className="recording-dot inline-block h-2 w-2 rounded-full bg-white" />
            Stop
          </>
        ) : (
          <>🎙 Record</>
        )}
      </button>
      {error ? <span className="text-xs text-red-400">{error}</span> : null}
    </div>
  );
}

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ];
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c;
  }
  return undefined;
}
