class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function badRequest(message) {
  return new ApiError(400, 'invalid_request', message);
}

function notFound(resource, id) {
  const label = resource.replace(/_/g, ' ');
  return new ApiError(404, `${resource}_not_found`, `No ${label} with id ${id}`);
}

function conflict(code, message) {
  return new ApiError(409, code, message);
}

module.exports = { ApiError, badRequest, notFound, conflict };
