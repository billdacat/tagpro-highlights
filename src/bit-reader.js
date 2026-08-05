// Reads bits sequentially from a Buffer, matching tagpro.eu's LogReader format.
export class BitReader {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0; // current bit position
  }

  readBool() {
    const byteIndex = this.pos >> 3;
    const bitIndex = 7 - (this.pos & 7); // MSB first
    this.pos++;
    return ((this.buf[byteIndex] >> bitIndex) & 1) === 1;
  }

  readFixed(bits) {
    let value = 0;
    for (let i = 0; i < bits; i++) {
      value = (value << 1) | (this.readBool() ? 1 : 0);
    }
    return value;
  }

  readTally() {
    let count = 0;
    while (this.readBool()) count++;
    return count;
  }

  // Matches tagpro.eu's readFooter() exactly:
  //   $size = readFixed(2) << 3
  //   $free = 8 - (pos & 7) & 7  (bits until next byte boundary)
  //   $size |= $free
  //   accumulate $minimum, then read $size bits and add $minimum
  readFooter() {
    const header = this.readFixed(2);
    let size = header << 3;
    const free = (8 - (this.pos & 7)) & 7;
    size |= free;

    let minimum = 0;
    let f = free;
    while (f < size) {
      minimum += 1 << f;
      f += 8;
    }

    return this.readFixed(size) + minimum;
  }

  get done() {
    return this.pos >= this.buf.length * 8;
  }
}
