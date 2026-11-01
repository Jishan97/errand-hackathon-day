import assert from "node:assert/strict";
import { test } from "node:test";
import { pcmuHasActivity } from "../src/phone/voice/caller-activity.js";

test("PCMU silence and low-level background are quiet; voiced energy can only postpone work", () => {
  for (const byte of [0xff, 0x7f, 0xfe, 0x7e]) assert.equal(pcmuHasActivity(Buffer.alloc(160, byte)), false);
  for (const byte of [0x80, 0x00, 0xa0]) assert.equal(pcmuHasActivity(Buffer.alloc(160, byte)), true);
  for (const bytes of [null, "audio", Buffer.alloc(1), Buffer.alloc(3201)]) assert.equal(pcmuHasActivity(bytes), false);
});
