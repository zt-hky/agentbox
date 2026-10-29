import { describe, expect, it } from "vitest";
import { ports, subuidStart, tenantUid } from "../src/slots.ts";

describe("slots", () => {
  const rows: [number, number, number, number, number][] = [
    [1, 200001, 300065536, 20002, 20003],
    [2, 200002, 300131072, 20004, 20005],
    [4999, 204999, 300000000 + 4999 * 65536, 29998, 29999],
  ];
  it.each(rows)("slot %i", (slot, uid, sub, t3, code) => {
    expect(tenantUid(slot)).toBe(uid);
    expect(subuidStart(slot)).toBe(sub);
    expect(ports(slot)).toEqual({ t3, code });
  });
  it.each([0, -1, 5000, 1.5, NaN])("rejects slot %s", (slot) => {
    expect(() => tenantUid(slot)).toThrow(RangeError);
    expect(() => subuidStart(slot)).toThrow(RangeError);
    expect(() => ports(slot)).toThrow(RangeError);
  });
});
