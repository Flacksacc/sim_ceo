// helper: build valid mono16 WAV + invalid variants (pure node, no deps)
export function makeWavMono16(sampleRate, seconds, freq) {
  const f = freq || 440;
  const n = Math.floor(sampleRate * seconds);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const s = Math.round(32767 * 0.5 * Math.sin((2 * Math.PI * f * i) / sampleRate));
    buf.writeInt16LE(s, 44 + i * 2);
  }
  return buf;
}
export function wavStats(buf) {
  const at = buf.indexOf(Buffer.from('RIFF'));
  if (at < 0) return { found: false };
  const sampleRate = buf.readUInt32LE(at + 24);
  const channels = buf.readUInt16LE(at + 22);
  const bits = buf.readUInt16LE(at + 34);
  const dataTag = buf.indexOf(Buffer.from('data'), at);
  const dataSize = dataTag >= 0 ? buf.readUInt32LE(dataTag + 4) : 0;
  const start = dataTag + 8;
  let sum2 = 0, nz = 0, zc = 0, count = 0, prevSign = 0;
  if (dataTag >= 0 && start + 2 <= buf.length) {
    const samples = Math.floor(Math.min(dataSize / 2, 16000 * 10));
    for (let i = 0; i < samples; i++) {
      const s = buf.readInt16LE(start + i * 2);
      sum2 += s * s; if (s !== 0) nz++;
      const sign = s > 0 ? 1 : s < 0 ? -1 : 0;
      if (i > 0 && sign !== 0 && prevSign !== 0 && sign !== prevSign) zc++;
      if (sign !== 0) prevSign = sign;
      count++;
    }
  }
  const rms = count ? Math.sqrt(sum2 / count) : 0;
  return { found: true, at, sampleRate, channels, bits, dataSize, rms, nz, zc, count };
}