// Shared transcription-engine contract. Both CloudEngine and LocalEngine expose
// the same `transcribe(wavPath) -> text` surface (as in the daemon), so the
// controller can swap them without caring which is active.
export interface Engine {
  readonly name: string;
  transcribe(wavPath: string): Promise<string>;
}
