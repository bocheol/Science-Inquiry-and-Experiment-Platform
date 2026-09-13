import assert from "node:assert/strict";

const base = process.argv[2] ?? "http://127.0.0.1:3000";
const network = "203.0.113.77";

function cookieFrom(response) {
  const raw = response.headers.getSetCookie?.()[0] ?? response.headers.get("set-cookie") ?? "";
  return raw.split(";", 1)[0];
}

async function login(loginId, password) {
  return fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": network },
    body: JSON.stringify({ loginId, password }),
  });
}

const firstLogin = await login("10901", "student1234");
assert.equal(firstLogin.status, 200, "initial student login");
const oldCookie = cookieFrom(firstLogin);
assert.ok(oldCookie, "initial session cookie");

const changed = await fetch(`${base}/api/auth/change-password`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie: oldCookie },
  body: JSON.stringify({ newPassword: "student5678" }),
});
assert.equal(changed.status, 200, "password change");
const newCookie = cookieFrom(changed);
assert.ok(newCookie && newCookie !== oldCookie, "renewed versioned session cookie");

assert.equal((await fetch(`${base}/api/inquiry`, { headers: { cookie: oldCookie } })).status, 403, "old session invalidated");
assert.equal((await fetch(`${base}/api/inquiry`, { headers: { cookie: newCookie } })).status, 200, "renewed session remains active");

for (let attempt = 1; attempt <= 8; attempt += 1) {
  const response = await login("missing-student", "wrong-password");
  assert.equal(response.status, attempt < 8 ? 401 : 429, `failed login attempt ${attempt}`);
}
assert.equal((await login("10902", "student1234")).status, 200, "another student on the shared network remains able to log in");

console.log(JSON.stringify({
  oldSessionInvalidated: true,
  renewedSessionActive: true,
  blockedAfterFailures: 8,
  sharedNetworkPeerLogin: true,
}));
