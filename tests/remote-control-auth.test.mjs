import test from 'node:test';
import assert from 'node:assert/strict';
import { remoteRequestOriginAllowed } from '../remote-control-auth.mjs';

const tailnet = 'mac.tailnet.ts.net';
const sameOrigin = `https://${tailnet}`;

test('remote browser writes remain limited to the exact Tailscale Serve origin', () => {
  assert.equal(remoteRequestOriginAllowed({ method: 'POST', origin: sameOrigin, dnsName: tailnet }), true);
  assert.equal(remoteRequestOriginAllowed({ method: 'POST', origin: 'https://other.tailnet.ts.net', dnsName: tailnet }), false);
  assert.equal(remoteRequestOriginAllowed({ method: 'POST', origin: 'https://mac.tailnet.ts.net.evil.example', dnsName: tailnet }), false);
});

test('iOS native writes may omit Origin only with the native client marker', () => {
  assert.equal(remoteRequestOriginAllowed({ method: 'POST', dnsName: tailnet, client: 'native-ios' }), true);
  assert.equal(remoteRequestOriginAllowed({ method: 'POST', dnsName: tailnet }), false);
  assert.equal(remoteRequestOriginAllowed({ method: 'POST', dnsName: tailnet, client: 'native-android' }), false);
});

test('a native marker never bypasses an explicitly cross-site request', () => {
  assert.equal(remoteRequestOriginAllowed({
    method: 'POST',
    origin: 'https://attacker.example',
    dnsName: tailnet,
    client: 'native-ios',
    fetchSite: 'cross-site',
  }), false);
  assert.equal(remoteRequestOriginAllowed({
    method: 'POST',
    dnsName: tailnet,
    client: 'native-ios',
    fetchSite: 'cross-site',
  }), false);
});

test('null Origin is accepted only from the marked native client', () => {
  assert.equal(remoteRequestOriginAllowed({ method: 'POST', origin: 'null', dnsName: tailnet, client: 'native-ios' }), true);
  assert.equal(remoteRequestOriginAllowed({ method: 'POST', origin: 'null', dnsName: tailnet }), false);
});

test('originless status reads stay available while unmarked originless writes are denied', () => {
  assert.equal(remoteRequestOriginAllowed({ method: 'GET', dnsName: tailnet }), true);
  assert.equal(remoteRequestOriginAllowed({ method: 'HEAD', dnsName: tailnet }), true);
  assert.equal(remoteRequestOriginAllowed({ method: 'OPTIONS', dnsName: tailnet }), false);
});
