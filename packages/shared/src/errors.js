/** Typed application errors that the error middleware maps to HTTP codes. */
export class AppError extends Error {
  constructor(message, { status = 500, code = 'INTERNAL_ERROR', details } = {}) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.code = code;
    this.details = details;
    this.expected = status < 500;
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Bad request', details) {
    super(message, { status: 400, code: 'BAD_REQUEST', details });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, { status: 401, code: 'UNAUTHORIZED' });
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Not allowed', details) {
    super(message, { status: 403, code: 'FORBIDDEN', details });
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super(message, { status: 404, code: 'NOT_FOUND' });
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflict', details) {
    super(message, { status: 409, code: 'CONFLICT', details });
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = 'Upstream service unavailable', details) {
    super(message, { status: 503, code: 'SERVICE_UNAVAILABLE', details });
  }
}
