import { z } from 'zod';
import { readStored } from './remember';

/** Per browser: whether a run the operator started plays a sound when it ends. On by default. */
export const CHIME_KEY = 'notify.sound';
export const chimeSchema = z.boolean();

/** Per browser: how loud the chime is, 0 to 100. Full by default. */
export const VOLUME_KEY = 'notify.volume';
export const volumeSchema = z.number().min(0).max(100);
export const DEFAULT_VOLUME = 100;

/** The loudest point of each note: half of full scale at volume 100, in proportion below. */
export const peakGain = (volume: number): number => 0.5 * (Math.min(Math.max(volume, 0), 100) / 100);

let context: AudioContext | null = null;

/**
 * Browsers start audio only after the operator touched the page, so the first click or key press opens it. The sound
 * is made here, two soft notes, so there is no audio file to load.
 */
export function unlockChime(): void {
  try {
    context ??= new AudioContext();
    if (context.state === 'suspended') void context.resume();
  } catch {
    // No Web Audio: the page stays silent.
  }
}

/**
 * A short rising pair for a run that finished, a falling one for a run that failed. Quiet, under a second. `always`
 * plays it with the sound turned off, for the Play button.
 */
export function playChime(outcome: 'done' | 'failed', always = false): void {
  if (!always && !readStored(CHIME_KEY, chimeSchema, true)) return;
  const audio = context;
  if (audio === null) return;
  const peak = peakGain(readStored(VOLUME_KEY, volumeSchema, DEFAULT_VOLUME));
  if (peak === 0) return;
  const play = () => {
    const start = audio.currentTime;
    const notes = outcome === 'done' ? [784, 1046.5] : [659.3, 523.3];
    for (const [index, frequency] of notes.entries()) note(audio, frequency, start + index * 0.13, peak);
  };
  if (audio.state === 'running') play();
  // Play is a click, so audio may start; a run that ended before any click stays silent, not queued for later.
  else if (always) void audio.resume().then(play);
}

function note(audio: AudioContext, frequency: number, at: number, peak: number): void {
  const oscillator = audio.createOscillator();
  const gain = audio.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(peak, at + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.45);
  oscillator.connect(gain).connect(audio.destination);
  oscillator.start(at);
  oscillator.stop(at + 0.5);
}
