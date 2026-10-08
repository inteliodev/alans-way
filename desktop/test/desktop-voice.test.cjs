const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { voiceReady, appendDictation, splitSentences, NOT_READY, LISTENING } = require('../src/intelio/desktop-voice.cjs');

const root = path.join(__dirname, '..');

test('desktop voice is ready only for Hermes audio or the VPS worker', () => {
  assert.equal(NOT_READY, "Voice isn't set up on the server yet");
  assert.equal(LISTENING, 'Listening…');
  assert.equal(voiceReady(null), false);
  assert.equal(voiceReady({ recommended: 'web', web: true }), false);
  assert.equal(voiceReady({ vps: true, recommended: 'vps' }), true);
  assert.equal(voiceReady({ hermesAudio: true, recommended: 'hermes' }), true);
  assert.equal(voiceReady({ recommended: 'hermes' }), true);
  assert.equal(appendDictation('Hello', 'there'), 'Hello there');
  assert.equal(appendDictation('', '  there  '), 'there');
  assert.equal(appendDictation('Hello', ''), 'Hello');
  const parts = splitSentences('First sentence. Second? Still going');
  assert.deepEqual(parts.sentences, ['First sentence.', 'Second?']);
  assert.equal(parts.rest, 'Still going');
});

test('desktop dictate uses the VPS voice routes and skips Web Speech', () => {
  const remote = fs.readFileSync(path.join(root, 'src/remote-main.js'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'src/intelio/remote-hermes-main.cjs'), 'utf8');
  const transport = fs.readFileSync(path.join(root, '../mobile/pwa/public/desktop-transport.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
  const electron = fs.readFileSync(path.join(root, 'src/main.cjs'), 'utf8');
  assert.equal(remote.includes('SpeechRecognition'), false);
  assert.equal(remote.includes('speechSynthesis'), false);
  assert.equal(remote.includes('webkitSpeech'), false);
  assert.equal(remote.includes('Dictation is not available'), false);
  assert.match(remote, /MediaRecorder/);
  assert.match(remote, /voice-transcribe/);
  assert.match(remote, /voice-speak/);
  assert.match(remote, /voice-status/);
  assert.match(remote, /getUserMedia/);
  assert.match(main, /\/api\/voice\/stt/);
  assert.match(main, /\/api\/voice\/tts/);
  assert.match(main, /x-intelio-engine/);
  assert.match(main, /x-intelio-profile/);
  assert.match(main, /VOICE_OFF/);
  assert.match(transport, /voice-transcribe/);
  assert.match(transport, /voice-speak/);
  assert.match(transport, /\/api\/voice\/stt/);
  assert.match(transport, /\/api\/voice\/tts/);
  assert.match(transport, /x-intelio-engine/);
  assert.match(transport, /Voice isn't set up on the server yet/);
  assert.match(html, /intelio\/desktop-voice\.cjs/);
  assert.match(html, /intelio\/calls\.cjs/);
  assert.equal(html.includes('host-labels.cjs'), false);
  assert.match(electron, /installAppMicrophone/);
  for (const file of [remote, main, transport]) {
    assert.equal(/openai|elevenlabs|speech\.googleapis|azure\.com/i.test(file), false);
  }
});
