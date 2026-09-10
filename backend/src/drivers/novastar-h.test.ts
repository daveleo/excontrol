import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import CryptoJS from "crypto-js";

/** H-series unencrypted signing: base64( md5_hex( timeStamp + pId ) ). */
function unencryptedSign(timeStamp: string, pId: string): string {
  const hex = createHash("md5").update(timeStamp + pId).digest("hex");
  return Buffer.from(hex, "utf8").toString("base64");
}

describe("h-series sign", () => {
  it("unencrypted sign is base64 of the 32-char md5 hex digest", () => {
    const s = unencryptedSign("1689586062335", "Y2E5");
    expect(Buffer.from(s, "base64").toString("utf8")).toMatch(/^[0-9a-f]{32}$/);
  });

  it("DES-ECB/PKCS7 round-trips with an 8-byte key", () => {
    const key = CryptoJS.enc.Utf8.parse("Mzg0YjA1");
    const opts = { mode: CryptoJS.mode.ECB, padding: CryptoJS.pad.Pkcs7 };
    const plain = JSON.stringify({ deviceId: 0, screenId: 1 });
    const ct = CryptoJS.DES.encrypt(plain, key, opts).toString();
    expect(CryptoJS.DES.decrypt(ct, key, opts).toString(CryptoJS.enc.Utf8)).toBe(plain);
  });
});
