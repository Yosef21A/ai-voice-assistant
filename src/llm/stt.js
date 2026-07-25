// Speech-to-text contract (V1) — the schema and the instruction, in one place.
//
// Kept separate from the provider so the CONTRACT is reviewable on its own and
// a second provider (or a self-hosted Whisper later) has one thing to satisfy.
//
// The instruction is deliberately narrow. A transcriber that "helps" is a
// liability in a medical product: translating hides what the patient said,
// summarising drops the one word that mattered, and answering the content would
// smuggle model prose past the executor and straight to a patient. It
// transcribes, or it says it could not.

/** Gemini responseSchema (OpenAPI subset) for one transcription. */
export const TRANSCRIPT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    transcript: { type: 'STRING' },
    language: { type: 'STRING', enum: ['ar', 'ar-Latn', 'fr', 'en', 'other'] },
    is_speech: { type: 'BOOLEAN' },
    unclear: { type: 'BOOLEAN' },
    confidence: { type: 'NUMBER' },
  },
  required: ['transcript', 'is_speech', 'unclear'],
};

export const STT_SYSTEM = [
  'You transcribe WhatsApp voice notes sent to a medical clinic in Tunisia.',
  '',
  'Transcribe VERBATIM, in the ORIGINAL language and the script actually spoken.',
  'Tunisian and Libyan Derja must come back in ARABIC SCRIPT, not romanised.',
  'Expect heavy code-switching between Derja and French — keep each word in the',
  'language it was said in; do not normalise the sentence into one language.',
  '',
  'NEVER translate. NEVER summarise. NEVER answer or react to what was said.',
  'NEVER add words that were not spoken, and never "repair" a half-finished',
  'sentence — a clinic acts on these words.',
  '',
  'Mark any span you could not make out as [?] rather than guessing at it.',
  'Set unclear:true when the audio is noisy, clipped or ambiguous.',
  'Set is_speech:false when the recording carries no speech at all (silence,',
  'noise, a pocket-dial, music).',
  'confidence is your own rough 0-1 estimate; be conservative.',
].join('\n');

/** Build the message the provider sends: inline audio + the instruction. */
export function buildTranscriptionRequest({ bytes, mimeType }) {
  return {
    system: STT_SYSTEM,
    schema: TRANSCRIPT_SCHEMA,
    temperature: 0,
    messages: [
      {
        role: 'user',
        parts: [
          { inline_data: { mime_type: mimeType, data: Buffer.from(bytes).toString('base64') } },
          { text: 'Transcribe this voice note.' },
        ],
      },
    ],
  };
}
