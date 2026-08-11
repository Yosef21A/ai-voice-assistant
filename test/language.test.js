import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectLanguage, resolveLanguage } from '../src/engine/language.js';

test('detects Arabic script', () => {
  assert.equal(detectLanguage('السلام عليكم'), 'ar');
  assert.equal(detectLanguage('نحب نحجز موعد'), 'ar');
  assert.equal(detectLanguage('اسمي محمد العبيدي'), 'ar');
});

test('detects French via keywords and accents', () => {
  assert.equal(detectLanguage('Bonjour, je voudrais un rendez-vous'), 'fr');
  assert.equal(detectLanguage('Chirurgie esthétique'), 'fr');
  assert.equal(detectLanguage("Je m'appelle Amina"), 'fr');
});

test('detects English', () => {
  assert.equal(detectLanguage('Hello, I want to book an appointment'), 'en');
  assert.equal(detectLanguage('How much is the dental price?'), 'en');
});

test('returns null for ambiguous input (a bare phone/number)', () => {
  assert.equal(detectLanguage('+218 92 000 0002'), null);
  assert.equal(detectLanguage('10:00'), null);
});

test('resolveLanguage falls back to previous then clinic default', () => {
  const clinic = { languages: ['ar', 'fr', 'en'] };
  assert.equal(resolveLanguage('en', 'ar', clinic), 'en'); // fresh detection wins
  assert.equal(resolveLanguage(null, 'ar', clinic), 'ar'); // remembered language
  assert.equal(resolveLanguage(null, null, clinic), 'ar'); // clinic primary
});
