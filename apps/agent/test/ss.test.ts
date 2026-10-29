import { describe, expect, it } from "vitest";
import { isLoopbackHost, parseSs, splitAddr, TrafficTracker, type TenantNet } from "../src/ss.ts";

const rec = (local: string, peer: string, uid: number, ino: number, acked: number, rcv: number) =>
  `0      0      ${local}      ${peer} uid:${uid} ino:${ino} sk:1 cgroup:/x <->\n\t ts sack cubic bytes_sent:99 bytes_acked:${acked} bytes_received:${rcv} segs_out:3\n`;

describe("parseSs", () => {
  it("parses multi-line records and sums acked + received", () => {
    const out = parseSs(rec("127.0.0.1:20000", "127.0.0.1:41000", 204998, 11, 100, 50));
    expect(out).toEqual([
      {
        inode: 11,
        uid: 204998,
        localHost: "127.0.0.1",
        localPort: 20000,
        peerHost: "127.0.0.1",
        peerPort: 41000,
        bytes: 150,
      },
    ]);
  });

  it("handles ipv6 brackets, missing uid and skips malformed records", () => {
    const text =
      "0 0 [::ffff:10.0.0.2]:5555 [2606:4700::1]:443 timer:(keepalive,1,0) ino:7 sk:2\n\t bytes_acked:5 bytes_received:6\n" +
      "garbage line\n";
    const out = parseSs(text);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      uid: null,
      localHost: "::ffff:10.0.0.2",
      peerHost: "2606:4700::1",
      peerPort: 443,
      bytes: 11,
    });
  });

  it("returns nothing for empty output", () => {
    expect(parseSs("")).toEqual([]);
  });
});

describe("addr helpers", () => {
  it("splits and classifies addresses", () => {
    expect(splitAddr("1.2.3.4:80")).toEqual({ host: "1.2.3.4", port: 80 });
    expect(splitAddr("[::1]:22")).toEqual({ host: "::1", port: 22 });
    expect(splitAddr("nonsense")).toBeNull();
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("1.1.1.1")).toBe(false);
  });
});

describe("TrafficTracker", () => {
  const UID = 200000 + 5;
  const tenants = new Map<number, TenantNet>([[UID, { ws: "alice", ports: [20010, 20011] }]]);

  it("counts gateway and egress per inode as deltas", () => {
    const t = new TrafficTracker();
    const first = parseSs(
      rec("127.0.0.1:20010", "127.0.0.1:50000", UID, 1, 100, 100) +
        rec("192.168.1.5:40000", "93.184.216.34:443", UID, 2, 10, 20),
    );
    const d1 = t.update(first, tenants).get("alice");
    expect(d1).toEqual({ gatewayBytes: 200, egressBytes: 30 });

    const second = parseSs(
      rec("127.0.0.1:20010", "127.0.0.1:50000", UID, 1, 150, 130) +
        rec("192.168.1.5:40000", "93.184.216.34:443", UID, 2, 10, 20),
    );
    const d2 = t.update(second, tenants).get("alice");
    expect(d2).toEqual({ gatewayBytes: 80, egressBytes: 0 });
  });

  it("counts a new inode fully and forgets closed ones", () => {
    const t = new TrafficTracker();
    t.update(parseSs(rec("127.0.0.1:20011", "127.0.0.1:1", UID, 1, 40, 0)), tenants);
    const d = t.update(parseSs(rec("127.0.0.1:20011", "127.0.0.1:2", UID, 9, 7, 0)), tenants);
    expect(d.get("alice")).toEqual({ gatewayBytes: 7, egressBytes: 0 });
    // inode 1 reappearing (reuse) counts from zero again
    const d3 = t.update(parseSs(rec("127.0.0.1:20011", "127.0.0.1:3", UID, 1, 4, 0)), tenants);
    expect(d3.get("alice")).toEqual({ gatewayBytes: 4, egressBytes: 0 });
  });

  it("ignores other users, loopback peers and unrelated ports", () => {
    const t = new TrafficTracker();
    const out = t.update(
      parseSs(
        rec("127.0.0.1:6769", "127.0.0.1:47192", 1000, 3, 999, 999) +
          rec("10.0.0.2:1234", "8.8.8.8:53", 1000, 4, 5, 5) +
          rec("127.0.0.1:40000", "127.0.0.1:22", UID, 5, 5, 5),
      ),
      tenants,
    );
    expect(out.size).toBe(0);
  });

  it("treats a counter that went backwards as a fresh socket", () => {
    const t = new TrafficTracker();
    t.update(parseSs(rec("127.0.0.1:20010", "127.0.0.1:1", UID, 1, 500, 0)), tenants);
    const d = t.update(parseSs(rec("127.0.0.1:20010", "127.0.0.1:1", UID, 1, 20, 0)), tenants);
    expect(d.get("alice")?.gatewayBytes).toBe(20);
  });
});
