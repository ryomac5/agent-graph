import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_BITS = 48n;
const RANDOM_BITS = 80n;
const RANDOM_BYTES = 10;
const ULID_LENGTH = 26;
const MAX_TIME = (1n << TIME_BITS) - 1n;
const MAX_RANDOM = (1n << RANDOM_BITS) - 1n;
const BASE = 32n;

let lastTime = -1n;
let lastRandom = 0n;

export function ulid(): string {
  let time = BigInt(Date.now());
  let random: bigint;
  if (time > lastTime) {
    random = BigInt(`0x${randomBytes(RANDOM_BYTES).toString("hex")}`);
  } else {
    // 時計が戻った場合も、直前の時刻と乱数の続きから採番する。
    time = lastTime;
    random = lastRandom + 1n;
    if (random > MAX_RANDOM) {
      time += 1n;
      random = 0n;
    }
  }
  if (time < 0n || time > MAX_TIME) {
    throw new RangeError("ULID timestamp is out of range");
  }
  lastTime = time;
  lastRandom = random;
  let value = (time << RANDOM_BITS) | random;
  let result = "";
  for (let index = 0; index < ULID_LENGTH; index += 1) {
    result = ALPHABET[Number(value % BASE)] + result;
    value /= BASE;
  }
  return result;
}
