'use strict';
/**
 * Write-only login fill instruction for the harness filler (CDP or cua-driver).
 * publicFill() is the only shape that may be logged or returned to the model.
 */

function buildFill({ domain, username, password, otp } = {}) {
  return {
    channel: 'harness-write-only',
    domain: String(domain || '').slice(0, 200),
    fields: [
      { name: 'username', value: String(username || '').slice(0, 200) },
      { name: 'password', value: String(password || '') },
      { name: 'otp', value: String(otp || '') },
    ],
  };
}

function publicFill(instruction) {
  return { channel: 'harness-write-only', domain: String(instruction?.domain || ''), filled: true };
}

function fieldValue(instruction, name) {
  return instruction?.fields?.find((field) => field.name === name)?.value || '';
}

module.exports = { buildFill, publicFill, fieldValue };
