import bcrypt from 'bcryptjs';

// 10 rounds: strong enough for this project, fast enough that the test suite
// (which registers many users) stays quick.
const ROUNDS = 10;

export const hashPassword = (plain) => bcrypt.hash(plain, ROUNDS);
export const verifyPassword = (plain, hash) => bcrypt.compare(plain, hash);

/** Pure validation logic — unit tested without any I/O. */
export function validatePasswordStrength(password) {
  const problems = [];
  if (password.length < 8) problems.push('must be at least 8 characters');
  if (!/[a-zA-Z]/.test(password)) problems.push('must contain a letter');
  if (!/[0-9]/.test(password)) problems.push('must contain a number');
  return { valid: problems.length === 0, problems };
}
