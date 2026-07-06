// IPC channel names shared between the main process and the renderers/preloads.
// Centralized so the main handlers and the preload bridges can't drift apart.
// M0 defines the surface; the recorder/overlay/dashboard channels are wired up
// in M1–M3 as those renderers come online.

export const IPC = {
  // --- Recorder renderer (hidden getUserMedia window) -> main ---------------
  recorder: {
    // main -> renderer: begin/stop capture
    start: 'recorder:start',
    stop: 'recorder:stop',
    // renderer -> main: a finished WAV buffer (ArrayBuffer)
    wav: 'recorder:wav',
    // renderer -> main: live RMS level for the meter
    rms: 'recorder:rms',
    // renderer -> main: getUserMedia failed (no mic / permission denied)
    error: 'recorder:error',
  },

  // --- Overlay renderer (pill) <- main -------------------------------------
  overlay: {
    // main -> renderer: {state, text, rms}
    state: 'overlay:state',
    // main -> renderer: begin fade-out
    dismiss: 'overlay:dismiss',
  },

  // --- Dashboard renderer <-> main (replaces the old HTTP :8765 server) ------
  dashboard: {
    stats: 'dashboard:stats',
    history: 'dashboard:history',
    getSettings: 'dashboard:getSettings',
    saveSettings: 'dashboard:saveSettings',
  },
} as const;

export type IpcChannels = typeof IPC;
