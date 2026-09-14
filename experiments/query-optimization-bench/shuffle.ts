/** 入力順を基準にした LCG と Fisher–Yates。呼び出し側で事前規則の順に整列する。 */
export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  let state = seed;
  const random = () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 4294967296; };
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  return shuffled;
}
