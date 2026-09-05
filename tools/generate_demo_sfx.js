const fs = require('fs');
const path = require('path');

const RATE = 48000;
const OUT = path.resolve(__dirname, '..', 'recordings');

function writeWav(name, seconds, sample) {
    const frames = Math.round(seconds * RATE);
    const data = Buffer.alloc(frames * 4);
    for (let i = 0; i < frames; i++) {
        const value = Math.max(-1, Math.min(1, sample(i / RATE, i)));
        const pcm = Math.round(value * 32767);
        data.writeInt16LE(pcm, i * 4);
        data.writeInt16LE(pcm, i * 4 + 2);
    }
    const wav = Buffer.alloc(44 + data.length);
    wav.write('RIFF'); wav.writeUInt32LE(36 + data.length, 4); wav.write('WAVE', 8);
    wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(2, 22); wav.writeUInt32LE(RATE, 24); wav.writeUInt32LE(RATE * 4, 28);
    wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36);
    wav.writeUInt32LE(data.length, 40); data.copy(wav, 44);
    fs.writeFileSync(path.join(OUT, name), wav);
    if (wav.length !== 44 + frames * 4) throw new Error('WAV length mismatch');
}

fs.mkdirSync(OUT, { recursive: true });
const notes = [440, 554.4, 659.3, 880, 740, 659.3, 554.4, 493.9];
writeWav('launch-celebration.wav', 7, (t, i) => {
    const step = 0.214;
    const local = t % step;
    const note = notes[Math.floor(t / step) % notes.length];
    const env = Math.min(1, local / 0.012) * Math.max(0, 1 - local / step);
    const lead = Math.sign(Math.sin(2 * Math.PI * note * t)) * 0.10 * env;
    const beat = t % (step * 4);
    const drum = beat < 0.22 ? Math.sin(2 * Math.PI * (120 - beat * 260) * beat) * 0.22 * Math.exp(-14 * beat) : 0;
    const cym = local < 0.08 && Math.floor(t / step) % 4 === 2
        ? (((i * 1103515245 + 12345) >>> 8) % 65536 / 32768 - 1) * 0.035 * Math.exp(-28 * local) : 0;
    return lead + drum + cym;
});

writeWav('deviation-tinnitus.wav', 5, t => {
    const attack = Math.min(1, t / 0.25);
    const release = Math.min(1, Math.max(0, (5 - t) / 2.2));
    const env = attack * release;
    return env * (0.018 * Math.sin(2 * Math.PI * 9200 * t) + 0.012 * Math.sin(2 * Math.PI * 6200 * t));
});

console.log('Demo SFX generated');
