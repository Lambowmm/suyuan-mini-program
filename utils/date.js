function pad(value) {
  return value < 10 ? '0' + value : '' + value;
}

function formatDate(date) {
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
}

function addDays(date, days) {
  var next = new Date(date.getTime());
  next.setDate(next.getDate() + days);
  return next;
}

function defaultRange() {
  var today = new Date();
  return {
    start: formatDate(addDays(today, -30)),
    end: formatDate(today),
    today: formatDate(today)
  };
}

function compareDate(left, right) {
  return new Date(left.replace(/-/g, '/')).getTime() - new Date(right.replace(/-/g, '/')).getTime();
}

module.exports = {
  defaultRange: defaultRange,
  compareDate: compareDate
};
