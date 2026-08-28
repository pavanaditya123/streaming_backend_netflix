import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { MemoryBus, getMemoryDb, verifyToken, EVENTS } from '@streaming/shared';
import { createUserApp } from '../src/app.js';
import { validatePasswordStrength } from '../src/domain/password.js';

const internal = (id) => ({ 'x-internal-secret': 'dev-only-internal-secret', 'x-user-id': id });

function build() {
  getMemoryDb().clear();
  const bus = new MemoryBus({ retryDelayMs: 1 });
  return { app: createUserApp({ bus }), bus };
}

const validUser = { email: 'a@b.com', password: 'secret123', displayName: 'Pavan', country: 'IN' };

describe('password rules (pure)', () => {
  test('accepts a strong password', () => {
    assert.equal(validatePasswordStrength('secret123').valid, true);
  });

  test('rejects a short password', () => {
    const r = validatePasswordStrength('ab1');
    assert.equal(r.valid, false);
    assert.ok(r.problems.some((p) => /8 characters/.test(p)));
  });

  test('requires a digit and a letter', () => {
    assert.equal(validatePasswordStrength('passwordd').valid, false);
    assert.equal(validatePasswordStrength('12345678').valid, false);
  });
});

describe('auth', () => {
  let ctx;
  beforeEach(() => { ctx = build(); });

  test('registration returns a usable JWT', async () => {
    const res = await request(ctx.app).post('/auth/register').send(validUser);
    assert.equal(res.status, 201);
    assert.ok(res.body.user.id.startsWith('usr_'));

    const claims = verifyToken(res.body.token);
    assert.equal(claims.sub, res.body.user.id);
    assert.equal(claims.email, validUser.email);
  });

  test('never returns the password hash', async () => {
    const res = await request(ctx.app).post('/auth/register').send(validUser);
    assert.equal(res.body.user.password_hash, undefined);
    assert.ok(!JSON.stringify(res.body).includes('$2'), 'no bcrypt hash may leak');
  });

  test('publishes user.registered', async () => {
    await request(ctx.app).post('/auth/register').send(validUser);
    await ctx.bus.drain();
    assert.equal(ctx.bus.eventsOfType(EVENTS.USER_REGISTERED).length, 1);
  });

  test('rejects a duplicate email', async () => {
    await request(ctx.app).post('/auth/register').send(validUser);
    const dup = await request(ctx.app).post('/auth/register').send(validUser);
    assert.equal(dup.status, 409);
  });

  test('rejects a malformed email', async () => {
    const res = await request(ctx.app).post('/auth/register').send({ ...validUser, email: 'not-an-email' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'BAD_REQUEST');
  });

  test('rejects a weak password with a reason', async () => {
    const res = await request(ctx.app).post('/auth/register').send({ ...validUser, password: 'passwordd' });
    assert.equal(res.status, 400);
    assert.ok(res.body.error.details.some((d) => /number/.test(d)));
  });

  test('logs in with correct credentials', async () => {
    await request(ctx.app).post('/auth/register').send(validUser);
    const res = await request(ctx.app).post('/auth/login')
      .send({ email: validUser.email, password: validUser.password });
    assert.equal(res.status, 200);
    assert.ok(res.body.token);
  });

  test('gives the SAME error for a wrong password and an unknown email', async () => {
    await request(ctx.app).post('/auth/register').send(validUser);
    const wrongPassword = await request(ctx.app).post('/auth/login')
      .send({ email: validUser.email, password: 'wrongpass1' });
    const unknownEmail = await request(ctx.app).post('/auth/login')
      .send({ email: 'nobody@b.com', password: 'secret123' });

    assert.equal(wrongPassword.status, 401);
    assert.equal(unknownEmail.status, 401);
    assert.equal(
      wrongPassword.body.error.message,
      unknownEmail.body.error.message,
      'the response must not reveal which emails are registered'
    );
  });
});

describe('internal trust boundary', () => {
  let ctx;
  beforeEach(() => { ctx = build(); });

  test('a forwarded identity WITHOUT the internal secret is refused', async () => {
    const reg = await request(ctx.app).post('/auth/register').send(validUser);
    const res = await request(ctx.app).get('/users/me').set('x-user-id', reg.body.user.id);
    assert.equal(res.status, 403, 'nobody may impersonate a user from outside the mesh');
  });

  test('a valid internal call resolves the profile', async () => {
    const reg = await request(ctx.app).post('/auth/register').send(validUser);
    const res = await request(ctx.app).get('/users/me').set(internal(reg.body.user.id));
    assert.equal(res.status, 200);
    assert.equal(res.body.user.email, validUser.email);
  });

  test('updates a profile', async () => {
    const reg = await request(ctx.app).post('/auth/register').send(validUser);
    const res = await request(ctx.app).put('/users/me')
      .set(internal(reg.body.user.id)).send({ displayName: 'Pavan A' });
    assert.equal(res.body.user.displayName, 'Pavan A');
  });
});
