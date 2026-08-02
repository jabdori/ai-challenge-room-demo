import { writeFileSync } from "node:fs";

const sentinelPath = process.env.CALIBRATION_NETWORK_SENTINEL;

globalThis.fetch = (async () => {
  if (sentinelPath) {
    writeFileSync(sentinelPath, "fetch attempted\n", { encoding: "utf8", mode: 0o600 });
  }
  throw new Error("keyless calibration에서 network fetch가 시도됐습니다.");
}) as typeof fetch;
