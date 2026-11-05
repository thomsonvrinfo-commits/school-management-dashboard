import { test } from "node:test";
import assert from "node:assert/strict";
import { browserOnline, explainNoAnswer, noAnswerLead } from "../src/lib/no-answer.ts";

test("a phone with no connection is told it is offline, and what to do", () => {
  assert.equal(noAnswerLead({}, false), "You are offline.");
  assert.equal(explainNoAnswer({}, false, "Connect to the internet to sign in."), "You are offline. Connect to the internet to sign in.");
  // offline wins even if an error number is present
  assert.equal(noAnswerLead({ status: 500 }, false), "You are offline.");
});

test("a server error is reported as a server error, never as being offline", () => {
  const text = explainNoAnswer({ status: 503 }, true, "Connect to the internet to sign in.");
  assert.match(text, /server had a problem \(503\)/);
  assert.doesNotMatch(text, /offline/i);
  assert.doesNotMatch(text, /Connect to the internet/);
});

test("no answer at all from a phone that says it is online says the server could not be reached", () => {
  const text = explainNoAnswer({}, true, "Connect to the internet to sign in.");
  assert.match(text, /Could not reach the server, although your phone says it is online/);
  assert.doesNotMatch(text, /You are offline/);
  assert.match(text, /tell the person who looks after SchoolPulse/);
});

test("when the browser cannot say whether it is online, the message does not claim to be offline", () => {
  assert.doesNotMatch(explainNoAnswer({}, undefined, "x"), /You are offline/);
  assert.equal(browserOnline(), undefined, "outside a browser there is no answer");
});
