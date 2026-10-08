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

// Feeds a level script: [[level, ms], ...] in 30 ms ticks. Returns [event, atMs] pairs;
// events.marks[i] is the time segment i started.
function run(detector, script, { agent = () => false, start = 0 } = {}) {
  const events = [];
  Object.defineProperty(events, 'marks', { value: [], enumerable: false });
  let now = start;
  let end = start;
  for (const [level, ms] of script) {
    events.marks.push(now);
    end += ms;
    while (now + 30 <= end) {
      now += 30;
      const event = detector.feed(level, now, { agentSpeaking: agent(now) });
      if (event) events.push([event, now]);
    }
  }
  return events;
}

test('a sentence with short pauses is one turn, sent after about 1.2 s of quiet', () => {
  const { createTurnDetector } = require('../src/intelio/desktop-voice.cjs');
  const turns = createTurnDetector();
  // Room noise, then "A few thoughts. [pause] One is, I need [pause] ..." with 0.7 s gaps.
  const events = run(turns, [[0.004, 1500], [0.12, 900], [0.006, 700], [0.1, 1200], [0.005, 800], [0.09, 600], [0.005, 2000]]);
  assert.deepEqual(events.map(([name]) => name), ['start', 'end']);
  const speechEndsAt = events.marks[6];
  const endAt = events[1][1];
  assert.equal(endAt - speechEndsAt >= 1200 && endAt - speechEndsAt <= 1300, true, `ended ${endAt - speechEndsAt} ms after speech`);
});

test('a click or a cough is not a turn', () => {
  const { createTurnDetector } = require('../src/intelio/desktop-voice.cjs');
  const turns = createTurnDetector();
  assert.deepEqual(run(turns, [[0.004, 1000], [0.3, 60], [0.004, 2000]]), []);
  const cough = run(turns, [[0.004, 500], [0.2, 240], [0.004, 2000]]);
  assert.deepEqual(cough.map(([name]) => name), ['start', 'cancel']);
});

test("the agent's own voice in the mic does not cut it off; talking over it does", () => {
  const { createTurnDetector } = require('../src/intelio/desktop-voice.cjs');
  const turns = createTurnDetector();
  const speaking = (now) => now > 1000 && now <= 6000;
  // Echo of the agent's speech, louder than the old 0.045 start level, for 5 s.
  const echo = run(turns, [[0.004, 1000], [0.07, 2500], [0.03, 500], [0.07, 2000], [0.004, 1500]], { agent: speaking });
  assert.deepEqual(echo, []);
  const turns2 = createTurnDetector();
  const barge = run(turns2, [[0.004, 1000], [0.07, 1000], [0.25, 1200], [0.004, 1500]], { agent: (now) => now > 1000 && now <= 2500 });
  assert.equal(barge[0][0], 'barge');
  const after = barge[0][1] - barge.marks[2];
  assert.equal(after >= 330 && after <= 420, true, `barge after ${after} ms`);
  assert.equal(barge[1][0], 'end');
  // Short loud bursts in the echo (a laugh in the reply) are not a barge-in.
  const bursts = [];
  for (let i = 0; i < 10; i += 1) bursts.push([0.15, 120], [0.05, 210]);
  assert.deepEqual(run(createTurnDetector(), [[0.004, 600], ...bursts], { agent: (now) => now > 600 }), []);
});

test('a noisy room raises the start level', () => {
  const { createTurnDetector, levelOf } = require('../src/intelio/desktop-voice.cjs');
  const turns = createTurnDetector();
  // Steady hiss at 0.016 becomes the floor; a quiet 0.04 murmur no longer starts a turn.
  assert.deepEqual(run(turns, [[0.016, 6000]]), []);
  assert.equal(turns.floor > 0.014, true);
  assert.deepEqual(run(turns, [[0.04, 600], [0.016, 1500]], { start: 6000 }), []);
  const said = run(turns, [[0.12, 800], [0.016, 1600]], { start: 8100 });
  assert.deepEqual(said.map(([name]) => name), ['start', 'end']);
  assert.equal(levelOf(new Uint8Array([128, 128, 128])), 0);
  assert.equal(Math.round(levelOf(new Uint8Array([0, 255, 0, 255])) * 100) / 100, 1);
});

test('desktop and phone calls share the turn detector and keep listening in the background', () => {
  const remote = fs.readFileSync(path.join(root, 'src/remote-main.js'), 'utf8');
  const phone = fs.readFileSync(path.join(root, '../mobile/pwa/public/app.js'), 'utf8');
  const phoneHtml = fs.readFileSync(path.join(root, '../mobile/pwa/public/index.html'), 'utf8');
  for (const source of [remote, phone]) {
    assert.match(source, /createTurnDetector\(\)/);
    assert.match(source, /setInterval\(vadTick/);
    assert.equal(/requestAnimationFrame\(\(?\)? ?=?>? ?vad/.test(source) || source.includes('requestAnimationFrame(vadLoop)'), false);
    assert.match(source, /replyMuted = true/);
    assert.match(source, /freshRecording/);
  }
  assert.match(phone, /async function callTurn\(/);
  assert.ok(phoneHtml.indexOf('/ui/intelio/desktop-voice.cjs') < phoneHtml.indexOf('/app.js'));
});
