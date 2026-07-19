import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectIntent } from '../src/engine/intent.js';

test('greeting', () => {
  assert.equal(detectIntent('السلام عليكم').intent, 'greeting');
  assert.equal(detectIntent('Bonjour').intent, 'greeting');
  assert.equal(detectIntent('Hello there').intent, 'greeting');
});

test('book_appointment', () => {
  assert.equal(detectIntent('نحب نحجز موعد').intent, 'book_appointment');
  assert.equal(detectIntent('Je voudrais prendre un rendez-vous').intent, 'book_appointment');
  assert.equal(detectIntent('I want to book an appointment').intent, 'book_appointment');
});

test('pricing_quote (and it wins over booking words)', () => {
  assert.equal(detectIntent('بقداش عملية القلب؟').intent, 'pricing_quote');
  assert.equal(detectIntent('Quel est le prix ?').intent, 'pricing_quote');
  assert.equal(detectIntent('How much does dental cost?').intent, 'pricing_quote');
});

test('travel_help', () => {
  assert.equal(detectIntent('نحتاج فندق وإقامة').intent, 'travel_help');
  assert.equal(detectIntent("J'ai besoin d'un hôtel").intent, 'travel_help');
  assert.equal(detectIntent('Do you help with the flight and hotel?').intent, 'travel_help');
});

test('human_handoff', () => {
  assert.equal(detectIntent('نحب نحكي مع موظف').intent, 'human_handoff');
  assert.equal(detectIntent('Je veux parler à un conseiller').intent, 'human_handoff');
  assert.equal(detectIntent('Can I talk to a human?').intent, 'human_handoff');
});

test('cancel', () => {
  assert.equal(detectIntent('نحب نلغي').intent, 'cancel');
  assert.equal(detectIntent('Annuler svp').intent, 'cancel');
  assert.equal(detectIntent('cancel please').intent, 'cancel');
});

test('unknown for gibberish', () => {
  assert.equal(detectIntent('xyzzy qwerty').intent, 'unknown');
});
