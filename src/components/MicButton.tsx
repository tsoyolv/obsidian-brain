"use client";

import { useEffect, useRef, useState } from "react";

interface Props {
  /** Called with the recorded audio blob and its mime type. */
  onRecorded: (blob: Blob, mimeType: string) => void;
  disabled?: boolean;
  className?: string;
  /** Label shown when idle (before recording starts). Defaults to "Record". */
  idleLabel?: string;
  /** Title attribute when idle — useful when two MicButtons sit next to each other. */
  idleTitle?: string;
  /** Visual variant for the idle state. */
  variant?: "default" | "primary";
}

/**
 * Microphone capture button using the MediaRecorder API.
 * - First click: starts recording.
 * - Second click: stops recording and emits the blob.
 *
 * While recording, displays a live MM:SS timer so the user knows the
 * capture is actually active.
 *
 * Supported in modern browsers; for unsupported browsers the button is disabled.
 */
export function MicButton({
  onRecorded,
  disabled,
  className,
  idleLabel = "Record",
  idleTitle,
  variant = "default",
}: Props) {
  const [recording, setRecording] = useState(false);
  const [supported, setSupported] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const startedAtRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
      if (timerRef.current) clearInterval(timerRef.current);
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
        if (timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
        setElapsedSec(0);
        onRecorded(blob, type);
      };
      recorderRef.current = rec;
      rec.start();
      startedAtRef.current = Date.now();
      setElapsedSec(0);
      timerRef.current = setInterval(() => {
        setElapsedSec(Math.floor((Date.now() - startedAtRef.current) / 1000));
      }, 250);
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

  const idleClass = variant === "primary" ? "btn-primary" : "btn";

  return (
    <div className={`flex items-center gap-2 ${className ?? ""}`}>
      <button
        type="button"
        onClick={recording ? stop : start}
        disabled={disabled}
        title={recording ? "Stop recording" : idleTitle ?? idleLabel}
        className={recording ? "btn-primary" : idleClass}
      >
        {recording ? (
          <>
            <span className="recording-dot inline-block h-2 w-2 rounded-full bg-white" />
            <span className="tabular-nums">{formatElapsed(elapsedSec)}</span>
            <span className="ml-1">Stop</span>
          </>
        ) : (
          <>🎙 {idleLabel}</>
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

function formatElapsed(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
