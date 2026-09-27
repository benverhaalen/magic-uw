import test from "node:test";
import assert from "node:assert/strict";
import { canvasFileHost } from "../packages/connectors/src/network";

const origin = "https://canvas.wisc.edu";

// Seen live on 2026-09-27: after the session download's redirect, Instructure's file service hands
// off to its CDN front, cdn.inst-fs-<region>-<env>.inscloudgate.net, and all 98 downloads stopped there.
test("Instructure's file-service CDN front is an allowed file host", () => {
  assert.equal(canvasFileHost("https://cdn.inst-fs-iad-prod.inscloudgate.net/files/u/name.pdf?token=t", origin), "inst_fs");
  assert.equal(canvasFileHost("https://cdn.inst-fs-pdx-beta.inscloudgate.net/files/u/n", origin), "inst_fs");
});

test("only exactly cdn. in front of an inst-fs host is accepted", () => {
  for (const url of [
    "http://cdn.inst-fs-iad-prod.inscloudgate.net/files/u", // not https
    "https://evil.inst-fs-iad-prod.inscloudgate.net/files/u", // any other prefix
    "https://cdn.evil.inst-fs-iad-prod.inscloudgate.net/files/u",
    "https://cdn.cdn.inst-fs-iad-prod.inscloudgate.net/files/u",
    "https://cdn.inscloudgate.net/files/u",
    "https://cdn.inst-fs-iad-prod.inscloudgate.net.evil.test/files/u", // suffix trick
    "https://cdninst-fs-iad-prod.inscloudgate.net/files/u",
    "https://user:pw@cdn.inst-fs-iad-prod.inscloudgate.net/files/u",
  ])
    assert.equal(canvasFileHost(url, origin), undefined, url);
});
