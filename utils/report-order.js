// The LIS contract returns descending pages only. Read the corresponding
// descending index window to produce complete ascending pages without fetching all reports.
function ascendingPager(request, params) {
  var cache = Object.create(null);
  var total;
  function fetch(page) {
    if (!cache[page]) {
      cache[page] = request('/reports', Object.assign({}, params, { page: page })).then(function(result) {
        if (!Array.isArray(result.items) || !Number.isInteger(result.total) || result.total < 0) {
          throw new Error('检验列表响应格式异常');
        }
        if (total !== undefined && total !== result.total) {
          throw new Error('报告数量已变化，请刷新查询');
        }
        total = result.total;
        return result;
      }).catch(function(error) { delete cache[page]; throw error; });
    }
    return cache[page];
  }
  return function(page) {
    return fetch(1).then(function() {
      var size = params.pageSize;
      var start = Math.max(0, total - page * size);
      var end = Math.max(0, total - (page - 1) * size);
      if (end <= start) return { total: total, items: [] };
      var first = Math.floor(start / size) + 1;
      var last = Math.floor((end - 1) / size) + 1;
      var requests = [];
      for (var p = first; p <= last; p++) requests.push(fetch(p));
      return Promise.all(requests).then(function(results) {
        var items = [];
        results.forEach(function(result) { items = items.concat(result.items); });
        return { total: total, items: items.slice(start - (first - 1) * size, end - (first - 1) * size).reverse() };
      });
    });
  };
}

function sortReports(reports, order) {
  return reports.slice().sort(function(a, b) {
    var left = Date.parse(String(a._date).replace(' ', 'T'));
    var right = Date.parse(String(b._date).replace(' ', 'T'));
    if (!Number.isFinite(left)) return Number.isFinite(right) ? 1 : 0;
    if (!Number.isFinite(right)) return -1;
    return order === 'asc' ? left - right : right - left;
  });
}

module.exports = { ascendingPager: ascendingPager, sortReports: sortReports };
