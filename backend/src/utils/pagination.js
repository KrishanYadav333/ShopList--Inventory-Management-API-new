// Parses ?page & ?limit with defaults and sane caps
function parsePagination(query) {
  const page = Math.max(parseInt(query.page || '1', 10), 1);
  const limitRaw = Math.max(parseInt(query.limit || '10', 10), 1);
  const limit = Math.min(limitRaw, 100); // cap at 100
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

module.exports = { parsePagination };