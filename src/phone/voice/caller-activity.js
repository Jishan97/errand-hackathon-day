// Conservative local activity guard, not speech recognition or permission.
// PCMU is one sample/byte at 8 kHz. It only postpones work on active input.
export function pcmuHasActivity(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 80 || bytes.length > 3200) return false;
  let energy = 0;
  for (const byte of bytes) {
    const sample = (~byte) & 255;
    const magnitude = (((sample & 15) * 8 + 132) << ((sample >> 4) & 7)) - 132;
    energy += magnitude * magnitude;
  }
  return energy / bytes.length >= 400 * 400;
}
